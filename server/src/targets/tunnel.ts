import { Duplex } from 'node:stream';
import { Client as SshClient } from 'ssh2';
import { decryptSecret } from '../security/crypto.ts';

/*
 * SSH tunnels to bastion hosts. Each tunnelled connection keeps one SSH session, and every pg
 * socket is an SSH channel (forwardOut) handed to pg through its `stream` option — there is no
 * local listening port another process could use. The bastion's host key must match the pinned
 * SHA256 fingerprint; there is no "accept any key".
 */

export interface SshConfig {
  id: string;
  host: string;
  port: number;
  dbHost: string;
  dbPort: number;
  ssh_host: string | null;
  ssh_port: number;
  ssh_user: string | null;
  ssh_auth: 'password' | 'key' | null;
  ssh_secret_enc: Buffer | null;
  ssh_host_key: string | null;
}

export class HostKeyMismatch extends Error {
  constructor(public fingerprint: string, public pinned: string | null) {
    super(pinned
      ? `SSH host key changed: expected ${pinned}, got ${fingerprint}. Refusing to connect.`
      : `Unknown SSH host key ${fingerprint}. Confirm the fingerprint with the bastion's owner, then save it.`);
  }
}

interface Session {
  stamp: string;
  ready: Promise<SshClient>;
  ssh: SshClient;
}
const sessions = new Map<string, Session>();

function stampOf(c: SshConfig): string {
  return [c.ssh_host, c.ssh_port, c.ssh_user, c.ssh_auth, c.ssh_host_key, c.dbHost, c.dbPort, c.ssh_secret_enc?.toString('base64') ?? ''].join('|');
}

function sshOptions(c: SshConfig, secret: string | null, onKey: (fp: string) => boolean) {
  return {
    host: c.ssh_host!,
    port: c.ssh_port || 22,
    username: c.ssh_user!,
    ...(c.ssh_auth === 'key' ? { privateKey: secret ?? undefined } : { password: secret ?? undefined }),
    readyTimeout: 10_000,
    keepaliveInterval: 15_000,
    hostHash: 'sha256',
    hostVerifier: (hash: string) => onKey('SHA256:' + Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '')),
  } as const;
}

/** Opens one SSH session just to read and check the host key (used by "Test connection"). */
export function probeHostKey(c: SshConfig, secretOverride?: string | null): Promise<{ fingerprint: string; ok: boolean }> {
  const secret = secretOverride !== undefined ? secretOverride : decryptSecret(c.ssh_secret_enc, `connection:${c.id}:ssh`);
  return new Promise((resolve, reject) => {
    const ssh = new SshClient();
    let fp = '';
    ssh.on('ready', () => { ssh.end(); resolve({ fingerprint: fp, ok: true }); });
    ssh.on('error', (e) => {
      ssh.end();
      if (fp && c.ssh_host_key !== fp) resolve({ fingerprint: fp, ok: false });
      else reject(e);
    });
    ssh.connect(sshOptions(c, secret, (got) => { fp = got; return !!c.ssh_host_key && got === c.ssh_host_key; }) as any);
  });
}

function session(c: SshConfig, secretOverride?: string | null): Promise<SshClient> {
  const stamp = stampOf(c);
  const hit = sessions.get(c.id);
  if (hit && hit.stamp === stamp) return hit.ready;
  if (hit) closeTunnel(c.id);
  if (!c.ssh_host_key) return Promise.reject(new HostKeyMismatch('(not checked yet)', null));
  const secret = secretOverride !== undefined ? secretOverride : decryptSecret(c.ssh_secret_enc, `connection:${c.id}:ssh`);
  const ssh = new SshClient();
  const ready = new Promise<SshClient>((resolve, reject) => {
    let keyErr: HostKeyMismatch | null = null;
    ssh.on('ready', () => resolve(ssh));
    ssh.on('error', (e) => {
      if (sessions.get(c.id)?.ssh === ssh) sessions.delete(c.id);
      reject(keyErr ?? e);
    });
    ssh.on('close', () => {
      if (sessions.get(c.id)?.ssh === ssh) sessions.delete(c.id);
    });
    ssh.connect(sshOptions(c, secret, (fp) => {
      if (fp === c.ssh_host_key) return true;
      keyErr = new HostKeyMismatch(fp, c.ssh_host_key);
      return false;
    }) as any);
  });
  sessions.set(c.id, { stamp, ready, ssh });
  return ready;
}

/**
 * A socket-shaped Duplex over one SSH channel. pg calls connect(), setNoDelay(), setKeepAlive()
 * and wraps it in TLS when the connection asks for SSL, exactly as with a net.Socket.
 */
class TunnelSocket extends Duplex {
  private channel: Duplex | null = null;
  private pending: Array<[Buffer, (e?: Error | null) => void]> = [];

  constructor(private open: () => Promise<SshClient>, private dbHost: string, private dbPort: number) {
    super();
  }

  connect(): this {
    this.open().then((ssh) => {
      ssh.forwardOut('127.0.0.1', 0, this.dbHost, this.dbPort, (err, ch) => {
        if (err) return this.destroy(err);
        this.channel = ch;
        ch.on('data', (d: Buffer) => { if (!this.push(d)) ch.pause(); });
        ch.on('end', () => this.push(null));
        ch.on('close', () => this.destroy());
        ch.on('error', (e: Error) => this.destroy(e));
        for (const [chunk, cb] of this.pending.splice(0)) ch.write(chunk, cb);
        this.emit('connect');
      });
    }).catch((e) => this.destroy(e));
    return this;
  }

  _read(): void {
    this.channel?.resume();
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (this.channel) this.channel.write(chunk, cb);
    else this.pending.push([chunk, cb]);
  }

  _final(cb: (e?: Error | null) => void): void {
    this.channel?.end();
    cb();
  }

  _destroy(err: Error | null, cb: (e: Error | null) => void): void {
    this.channel?.destroy();
    cb(err);
  }

  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

/** Returns a pg `stream` factory: each pg connection becomes one channel through the bastion. */
export function tunnelStream(c: SshConfig, secretOverride?: string | null): () => Duplex {
  return () => new TunnelSocket(() => session(c, secretOverride), c.dbHost, c.dbPort);
}

/** Opens the SSH session up front so host-key and auth errors surface before pg starts. */
export async function openTunnel(c: SshConfig, secretOverride?: string | null): Promise<void> {
  await session(c, secretOverride);
}

export function closeTunnel(connId: string): void {
  const s = sessions.get(connId);
  if (!s) return;
  sessions.delete(connId);
  try { s.ssh.end(); } catch { /* already closed */ }
}
