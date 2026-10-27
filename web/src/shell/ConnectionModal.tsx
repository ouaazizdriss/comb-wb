import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { parseDsn, CONNECTION_COLORS, SSL_MODES, type ConnectionSummary, type Environment } from '@comb/shared';
import { api, ApiError } from '../lib/api.ts';
import { useApp, toastError } from '../lib/store.ts';
import { Modal, Button, Seg, Toggle, IDC, Label, EnvBadge, TextInput } from '../ui/index.tsx';

interface Form {
  name: string; host: string; port: string; db: string; user: string; password: string; dsn: string;
  color: string; env: Environment; readOnly: boolean; requireApproval: boolean; sslmode: (typeof SSL_MODES)[number]; sslCa: string;
  ssh: boolean; sshHost: string; sshPort: string; sshUser: string; sshAuth: 'password' | 'key'; sshSecret: string; sshHostKey: string | null;
}

const SSL_HINT: Record<string, string> = {
  disable: 'No encryption. Only for a database on this machine.',
  prefer: 'Encrypts when the server offers TLS; does not verify the server.',
  require: 'Always encrypted; does not verify the server certificate.',
  'verify-ca': 'Encrypted and the certificate must chain to the CA below.',
  'verify-full': 'Encrypted, CA-verified, and the host name must match. Use this for anything remote.',
};

export function ConnectionModal() {
  const modal = useApp((s) => s.connModal)!;
  const set = useApp((s) => s.set);
  const toast = useApp((s) => s.toast);
  const qc = useQueryClient();
  const c = modal.conn;
  const [f, setF] = useState<Form>({
    name: c?.name ?? '', host: c?.host ?? '', port: String(c?.port ?? 5432), db: c?.db ?? '', user: c?.user ?? '', password: '',
    dsn: '', color: c?.color ?? 'slate', env: c?.env ?? 'local', readOnly: c?.readOnly ?? false, requireApproval: c?.requireApproval ?? false,
    sslmode: c?.sslmode ?? 'prefer', sslCa: '',
    ssh: !!c?.ssh, sshHost: c?.ssh?.host ?? '', sshPort: String(c?.ssh?.port ?? 22), sshUser: c?.ssh?.user ?? '', sshAuth: c?.ssh?.auth ?? 'password',
    sshSecret: '', sshHostKey: c?.ssh?.hostKey ?? null,
  });
  const [sshTouched, setSshTouched] = useState(false);
  const [pwTouched, setPwTouched] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string; hint?: string; hostKey?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteWord, setDeleteWord] = useState<string | null>(null);
  const close = () => set({ connModal: null });
  const up = (patch: Partial<Form>) => { setF((x) => ({ ...x, ...patch })); setTest(null); };

  // Fill the fields from a whole connection string: on paste, Enter or leaving the field, never mid-typing.
  const applyDsn = (v: string): boolean => {
    const p = parseDsn(v.trim());
    if (!p) return false;
    setF((x) => ({ ...x, dsn: '', host: p.host ?? x.host, port: String(p.port ?? 5432), db: p.db ?? x.db, user: p.user ?? x.user,
      password: p.password ?? x.password, name: x.name || (p.db ?? ''), sslmode: p.sslmode ?? x.sslmode }));
    if (p.password !== undefined) setPwTouched(true);
    setTest(null);
    return true;
  };

  const payload = () => ({
    name: f.name.trim(), host: f.host.trim(), port: Number(f.port) || 5432, db: f.db.trim(), user: f.user.trim(),
    color: f.color, env: f.env, readOnly: f.readOnly, requireApproval: f.requireApproval, sslmode: f.sslmode,
    ...(f.sslCa.trim() ? { sslCa: f.sslCa.trim() } : {}),
    ...(c ? (pwTouched ? { password: f.password } : {}) : { password: f.password }),
    ...(f.ssh
      ? { sshHost: f.sshHost.trim(), sshPort: Number(f.sshPort) || 22, sshUser: f.sshUser.trim(), sshAuth: f.sshAuth, sshHostKey: f.sshHostKey,
          ...(c?.ssh && !sshTouched ? {} : { sshSecret: f.sshSecret }) }
      : c?.ssh ? { sshHost: null } : {}),
  });

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const p = payload();
      const r = await api.post('/connections/test', c ? { id: c.id, ...p } : p);
      setTest(r);
    } catch (e) {
      setTest({ ok: false, text: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      if (c) await api.patch(`/connections/${c.id}`, payload());
      else await api.post('/connections', payload());
      await qc.invalidateQueries({ queryKey: ['connections'] });
      toast('Connection saved', `${f.name} · ${f.env}${f.readOnly ? ' · read-only' : ''}`);
      close();
    } catch (e) {
      toastError(e, 'Could not save the connection');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!c) return;
    try {
      await api.del(`/connections/${c.id}`, { confirm: deleteWord ?? '' });
      await qc.invalidateQueries({ queryKey: ['connections'] });
      toast('Connection removed', c.name, 'info');
      close();
    } catch (e) {
      if (!(e instanceof ApiError && e.confirm)) toastError(e, 'Could not remove the connection');
    }
  };

  const prodRoOff = f.env === 'prod' && !f.readOnly;

  return (
    <Modal
      title={c ? 'Edit connection' : 'New connection'}
      onClose={close}
      width={780}
      footer={
        <>
          <Button onClick={runTest} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</Button>
          {c ? (
            deleteWord === null ? <Button variant="danger-ghost" onClick={() => setDeleteWord('')}>Remove…</Button> : (
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <TextInput mono value={deleteWord} onChange={(e) => setDeleteWord(e.target.value)} placeholder={`type ${c.name}`} style={{ height: 26, width: 170 }} />
                <Button variant="danger" disabled={deleteWord !== c.name} onClick={remove}>Remove</Button>
              </span>
            )
          ) : null}
          <span className="spacer" />
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving || !f.name || !f.host || !f.db || !f.user || (f.ssh && !f.sshHostKey)} title={f.ssh && !f.sshHostKey ? 'Test the connection and confirm the SSH host key first' : undefined}>Save</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <Label>Paste a connection string</Label>
            <TextInput mono value={f.dsn} onChange={(e) => setF((x) => ({ ...x, dsn: e.target.value }))}
              onPaste={(e) => { if (applyDsn(e.clipboardData.getData('text'))) e.preventDefault(); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyDsn(f.dsn); } }}
              onBlur={() => applyDsn(f.dsn)}
              placeholder="postgresql://user:pass@host:5432/db" autoComplete="off" />
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Optional. Paste, or type and press Enter, to fill the fields below — or fill them directly. The string itself is not stored.</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Label>Connection</Label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {([
                ['Name', 'name', 'text', 'analytics_prod'], ['Host', 'host', 'text', 'db.internal'], ['Port', 'port', 'text', '5432'],
                ['Database', 'db', 'text', 'analytics'], ['User', 'user', 'text', 'postgres'], ['Password', 'password', 'password', c?.hasPassword ? '•••••••• (unchanged)' : '••••••••'],
              ] as const).map(([label, key, type, ph]) => (
                <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span>
                  <TextInput mono={key !== 'name'} type={type} value={(f as any)[key]} placeholder={ph} autoComplete={key === 'password' ? 'new-password' : 'off'}
                    onChange={(e) => { if (key === 'password') setPwTouched(true); up({ [key]: e.target.value } as Partial<Form>); }} />
                </label>
              ))}
            </div>
            {c && (f.host !== c.host || Number(f.port) !== c.port || f.user !== c.user || f.db !== c.db) && !pwTouched && c.hasPassword ? (
              <div style={{ fontSize: 12, color: 'var(--state-running)' }}>The stored password is only sent to the original server. Re-enter it for the new target.</div>
            ) : null}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Label>Identity</Label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', width: 90 }}>Display colour</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {CONNECTION_COLORS.map((k) => (
                  <button key={k} title={k} onClick={() => up({ color: k })}
                    style={{ width: 18, height: 18, borderRadius: 3, background: IDC[k], border: f.color === k ? '2px solid var(--text-primary)' : '1px solid var(--border-subtle)' }} />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', width: 90 }}>Environment</span>
              <Seg options={['local', 'dev', 'staging', 'prod'] as const} value={f.env}
                onChange={(v) => up({ env: v, ...(v === 'prod' ? { readOnly: true, requireApproval: true } : {}) })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', width: 90 }}>Read-only</span>
              <Toggle on={f.readOnly} onChange={(v) => up({ readOnly: v })} />
              <span style={{ fontSize: 12, color: prodRoOff ? 'var(--danger)' : 'var(--text-muted)' }}>
                {f.env === 'prod' ? (f.readOnly ? 'Recommended for prod — on.' : 'Overridden. Writes will reach production.') : 'Sessions run inside READ ONLY transactions.'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', width: 90 }}>Approvals</span>
              <Toggle on={f.requireApproval} onChange={(v) => up({ requireApproval: v })} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Writes wait for a second person who did not author them.</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Label>SSL & tunnel</Label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', width: 90 }}>Mode</span>
              <select value={f.sslmode} onChange={(e) => up({ sslmode: e.target.value as Form['sslmode'] })}
                style={{ height: 26, border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', padding: '0 6px', fontFamily: 'var(--mono)', fontSize: 12 }}>
                {SSL_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <span style={{ fontSize: 12, color: f.sslmode.startsWith('verify') ? 'var(--text-muted)' : 'var(--state-running)' }}>{SSL_HINT[f.sslmode]}</span>
            </div>
            {!f.ssh ? (
              <div><Button size="sm" onClick={() => up({ ssh: true })}>＋ SSH tunnel</Button></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, border: '1px solid var(--border-subtle)', borderRadius: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, fontWeight: 500 }}>SSH tunnel</span><span className="spacer" />
                  <button className="hov-text" style={{ fontSize: 12, color: 'var(--text-muted)' }} onClick={() => up({ ssh: false })}>remove</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 70px 1fr', gap: 8 }}>
                  <TextInput mono placeholder="bastion.example.com" value={f.sshHost} onChange={(e) => { setSshTouched(true); up({ sshHost: e.target.value, sshHostKey: null }); }} />
                  <TextInput mono placeholder="22" value={f.sshPort} onChange={(e) => { setSshTouched(true); up({ sshPort: e.target.value, sshHostKey: null }); }} />
                  <TextInput mono placeholder="ssh user" value={f.sshUser} onChange={(e) => { setSshTouched(true); up({ sshUser: e.target.value }); }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Seg options={['password', 'key'] as const} value={f.sshAuth} onChange={(v) => { setSshTouched(true); up({ sshAuth: v, sshSecret: '' }); }} />
                  {f.sshAuth === 'password' ? (
                    <TextInput type="password" autoComplete="new-password" style={{ flex: 1 }} placeholder={c?.ssh?.hasSecret && !sshTouched ? '•••••••• (unchanged)' : 'SSH password'}
                      value={f.sshSecret} onChange={(e) => { setSshTouched(true); up({ sshSecret: e.target.value }); }} />
                  ) : null}
                </div>
                {f.sshAuth === 'key' ? (
                  <textarea value={f.sshSecret} onChange={(e) => { setSshTouched(true); up({ sshSecret: e.target.value }); }} spellCheck={false}
                    placeholder={c?.ssh?.hasSecret && !sshTouched ? 'Private key stored. Paste a new one to replace it.' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                    style={{ height: 70, border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', padding: 8, fontFamily: 'var(--mono)', fontSize: 11, resize: 'vertical' }} />
                ) : null}
                <div style={{ fontSize: 11, color: f.sshHostKey ? 'var(--text-muted)' : 'var(--state-running)', fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
                  {f.sshHostKey ? 'host key pinned · ' + f.sshHostKey : 'host key not pinned yet — Test connection shows it for you to confirm'}
                </div>
              </div>
            )}
            {f.sslmode.startsWith('verify') ? (
              <textarea value={f.sslCa} onChange={(e) => up({ sslCa: e.target.value })} spellCheck={false}
                placeholder={c ? 'CA certificate (PEM). Leave empty to keep the stored one or use the system trust store.' : 'CA certificate (PEM), only needed for a private CA'}
                style={{ height: 70, border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', padding: 8, fontFamily: 'var(--mono)', fontSize: 11, resize: 'vertical' }} />
            ) : null}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Label>Summary</Label>
          <div style={{ display: 'flex', border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: 3, flex: 'none', background: IDC[f.color] }} />
            <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="mono" style={{ fontWeight: 500 }}>{f.name || 'untitled'}</span><EnvBadge env={f.env} /></div>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{(f.host || 'host') + ':' + (f.port || '5432') + ' · ' + (f.user || 'user')}</span>
            </div>
          </div>
          <div style={{ border: '1px solid ' + (test && !test.ok ? 'var(--state-error)' : 'var(--border-subtle)'), borderLeft: '3px solid ' + (test ? (test.ok ? 'var(--state-success)' : 'var(--state-error)') : 'var(--border-strong)'),
            borderRadius: 3, padding: '9px 10px', background: 'var(--bg-base)', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: '17px',
            color: test ? (test.ok ? 'var(--state-success)' : 'var(--state-error)') : 'var(--text-muted)', wordBreak: 'break-word' }}>
            {test ? (test.ok ? '✓ ' : '') + test.text : testing ? 'testing…' : 'Not tested yet.'}
            {test?.hint ? <div style={{ fontFamily: 'var(--sans)', color: 'var(--text-secondary)', marginTop: 6 }}>{test.hint}</div> : null}
            {test?.hostKey && !f.sshHostKey ? (
              <div style={{ marginTop: 8 }}>
                <Button size="sm" onClick={() => { setF((x) => ({ ...x, sshHostKey: test.hostKey! })); setTest(null); }}>Trust this host key</Button>
              </div>
            ) : null}
          </div>
          <span className="spacer" />
          <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--text-muted)' }}>Passwords are encrypted at rest and never returned by the API.</div>
        </div>
      </div>
    </Modal>
  );
}
