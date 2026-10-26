import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { vetHost } from './ssrf.ts';

/*
 * Minimal SMTP client: EHLO, STARTTLS (or implicit TLS), AUTH PLAIN/LOGIN, MAIL/RCPT/DATA, QUIT.
 * The server host goes through the same SSRF vetting as HTTP and the socket connects to the
 * vetted address. Certificates are verified against the host name. 'none' (plaintext) refuses
 * to send credentials.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  tls: 'starttls' | 'tls' | 'none';
  user?: string;
  password?: string | null;
  from: string;
  to: string[];
}

export interface MailMessage {
  subject: string;
  text: string;
  attachment?: { filename: string; contentType: string; body: string };
}

const ADDR = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/;

class Reader {
  private buf = '';
  private waiters: Array<(s: string) => void> = [];
  private sock: net.Socket | tls.TLSSocket;
  private err: Error | null = null;
  constructor(sock: net.Socket | tls.TLSSocket) {
    this.sock = sock;
    this.attach(sock);
  }
  attach(sock: net.Socket | tls.TLSSocket): void {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      this.flush();
    });
    sock.on('error', (e) => {
      this.err = e;
      this.flush();
    });
  }
  detach(): void {
    this.sock.removeAllListeners('data');
  }
  private flush(): void {
    while (this.waiters.length) {
      if (this.err) {
        this.waiters.shift()!('ERR ' + this.err.message);
        continue;
      }
      // A full reply ends with a line "ddd text" (space, not dash, after the code).
      const lines = this.buf.split('\r\n');
      let end = -1;
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3}( |$)/.test(lines[i])) { end = i; break; }
      if (end === -1) return;
      const reply = lines.slice(0, end + 1).join('\n');
      this.buf = lines.slice(end + 1).join('\r\n');
      this.waiters.shift()!(reply);
    }
  }
  next(): Promise<string> {
    return new Promise((r) => {
      this.waiters.push(r);
      this.flush();
    });
  }
}

function code(reply: string): number {
  return Number(reply.slice(0, 3)) || 0;
}

function header(s: string): string {
  // RFC 2047 encode anything non-ASCII; strip CR/LF to prevent header injection.
  const clean = s.replace(/[\r\n]+/g, ' ').slice(0, 300);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean).toString('base64')}?=`;
}

function b64lines(s: string): string {
  return (Buffer.from(s, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

export function buildMime(cfg: SmtpConfig, msg: MailMessage): string {
  const boundary = 'comb-' + crypto.randomBytes(12).toString('hex');
  const head = [
    `From: ${cfg.from}`,
    `To: ${cfg.to.join(', ')}`,
    `Subject: ${header(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@comb>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];
  let body: string;
  if (msg.attachment) {
    const fname = msg.attachment.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
    const ctype = /^[a-z]+\/[a-z0-9.+-]+$/i.test(msg.attachment.contentType) ? msg.attachment.contentType : 'application/octet-stream';
    head.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    body = [
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(msg.text),
      `--${boundary}`, `Content-Type: ${ctype}; name="${fname}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${fname}"`, '', b64lines(msg.attachment.body),
      `--${boundary}--`, '',
    ].join('\r\n');
  } else {
    head.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    body = b64lines(msg.text) + '\r\n';
  }
  return head.join('\r\n') + '\r\n\r\n' + body;
}

export async function sendMail(cfg: SmtpConfig, msg: MailMessage, opts: { timeoutMs?: number; allowHosts?: string[] } = {}): Promise<string> {
  if (!ADDR.test(cfg.from) || !cfg.to.length || !cfg.to.every((t) => ADDR.test(t))) throw new Error('Invalid sender or recipient address');
  if (cfg.tls === 'none' && cfg.user) throw new Error('Refusing to send SMTP credentials over an unencrypted connection');
  const vetted = await vetHost(cfg.host, opts.allowHosts);
  const timeout = opts.timeoutMs ?? 15_000;
  const servername = net.isIP(vetted.host) ? undefined : vetted.host;

  let sock: net.Socket | tls.TLSSocket = await new Promise((resolve, reject) => {
    const s = cfg.tls === 'tls'
      ? tls.connect({ host: vetted.address, port: cfg.port, servername, minVersion: 'TLSv1.2' }, () => resolve(s))
      : net.connect({ host: vetted.address, port: cfg.port }, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(timeout, () => s.destroy(new Error('SMTP timed out')));
  });
  const r = new Reader(sock);
  const cmd = async (line: string | null, expect: number[], what: string): Promise<string> => {
    if (line !== null) sock.write(line + '\r\n');
    const reply = await r.next();
    if (!expect.includes(code(reply))) throw new Error(`SMTP ${what} failed: ${reply.split('\n').pop()!.slice(0, 160)}`);
    return reply;
  };
  try {
    await cmd(null, [220], 'greeting');
    let ehlo = await cmd('EHLO comb.local', [250], 'EHLO');
    if (cfg.tls === 'starttls') {
      if (!/STARTTLS/i.test(ehlo)) throw new Error('The SMTP server does not offer STARTTLS');
      await cmd('STARTTLS', [220], 'STARTTLS');
      r.detach();
      sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const t = tls.connect({ socket: sock as net.Socket, servername, minVersion: 'TLSv1.2' }, () => resolve(t));
        t.once('error', reject);
      });
      r.attach(sock);
      ehlo = await cmd('EHLO comb.local', [250], 'EHLO');
    }
    if (cfg.user) {
      const pw = cfg.password ?? '';
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo)) {
        await cmd('AUTH PLAIN ' + Buffer.from(`\0${cfg.user}\0${pw}`).toString('base64'), [235], 'AUTH');
      } else {
        await cmd('AUTH LOGIN', [334], 'AUTH');
        await cmd(Buffer.from(cfg.user).toString('base64'), [334], 'AUTH');
        await cmd(Buffer.from(pw).toString('base64'), [235], 'AUTH');
      }
    }
    await cmd(`MAIL FROM:<${cfg.from}>`, [250], 'MAIL FROM');
    for (const t of cfg.to) await cmd(`RCPT TO:<${t}>`, [250, 251], 'RCPT TO');
    await cmd('DATA', [354], 'DATA');
    const data = buildMime(cfg, msg).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const done = await cmd(data + '\r\n.', [250], 'DATA');
    await cmd('QUIT', [221], 'QUIT').catch(() => '');
    return done.slice(4, 120);
  } finally {
    sock.destroy();
  }
}
