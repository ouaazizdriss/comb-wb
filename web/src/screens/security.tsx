import { useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tab } from '../lib/store.ts';
import { useApp } from '../lib/store.ts';
import { api, ApiError, setCsrf } from '../lib/api.ts';
import { ago, dateTime } from '../lib/format.ts';
import { Button, Seg, Toggle, TextInput, Modal, Loading, ErrorBox, Callout, Label, COND, MONO } from '../ui/index.tsx';

/* Security (mockup isSecurityTab): sessions, API tokens, IP allowlist, policy, and the current user's two-factor + password. */

interface Session { id: string; device: string; userAgent: string; ip: string | null; createdAt: string; lastSeenAt: string; current: boolean; mfaPending: boolean; auth: string }
interface Token { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; expired: boolean }
interface IpView { list: Array<{ cidr: string; note: string }>; yourIp: string; loopback: boolean; loopbackBypass: boolean; yourIpAllowed: boolean; yourIpListed: boolean }
interface Policy { requireMfa: boolean; ssoOnly: boolean; blockExportOnProd: boolean; sessionIdleMinutes: number; ssoEnabled: boolean }
interface MeSec { id: string; email: string; role: string; via: string; auth: string; mfaEnabled: boolean; hasPassword: boolean; requireMfa: boolean }

const cond: CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' };
const headCell: CSSProperties = { padding: '5px 10px', borderRight: '1px solid var(--border-subtle)' };
const smallBtn: CSSProperties = { height: 22, padding: '0 9px', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 12, whiteSpace: 'nowrap' };
const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
const isAdmin = (r?: string) => r === 'Admin' || r === 'Owner';

function Head({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="label">{label}</span>
      <span className="spacer" />
      {children}
    </div>
  );
}

function Copy({ value }: { value: string }) {
  const toast = useApp((s) => s.toast);
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()}
        style={{ flex: 1, height: 28, padding: '0 9px', border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', fontFamily: MONO, fontSize: 12 }} />
      <Button onClick={() => { void navigator.clipboard?.writeText(value).then(() => toast('Copied', undefined, 'success')).catch(() => toast('Copy failed — select and copy it', undefined, 'error')); }}>Copy</Button>
    </div>
  );
}

// ── Sessions ────────────────────────────────────────────────────────────────

function Sessions({ me }: { me: MeSec }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [user, setUser] = useState<string>('');
  const members = useQuery({ queryKey: ['team', 'members'], queryFn: () => api.get('/team/members'), enabled: isAdmin(me.role) });
  const q = useQuery({ queryKey: ['security', 'sessions', user], queryFn: () => api.get<{ sessions: Session[]; user: { email: string } }>('/security/sessions' + (user ? '?user=' + user : '')) });
  const self = !user || user === me.id;
  const refresh = () => qc.invalidateQueries({ queryKey: ['security', 'sessions'] });
  const revoke = async (s: Session) => {
    try {
      await api.del('/security/sessions/' + s.id);
      toast('Session revoked', 'That device is signed out on its next request.', 'success');
      void refresh();
    } catch (e) { toast(errText(e), undefined, 'error'); }
  };
  const revokeAll = async () => {
    try {
      const r = await api.post('/security/sessions/revoke-others', user ? { user } : {});
      toast(`${r.revoked} session${r.revoked === 1 ? '' : 's'} revoked`, self ? 'Every device except this one is signed out. Tokens are unaffected — revoke those separately.' : 'Every device of that member is signed out.', 'success');
      void refresh();
    } catch (e) { toast(errText(e), undefined, 'error'); }
  };
  const list = q.data?.sessions ?? [];
  const others = list.filter((s) => !s.current).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Head label="Workspace sessions">
        {isAdmin(me.role) && members.data ? (
          <select value={user} onChange={(e) => setUser(e.target.value)} style={{ height: 22, maxWidth: 260, fontSize: 12, border: '1px solid var(--border-subtle)', borderRadius: 3, padding: '0 4px', background: 'var(--bg-raised)' }}>
            <option value="">Mine</option>
            {members.data.members.filter((m: any) => !m.me && m.status === 'active' && m.role !== 'Service').map((m: any) => <option key={m.id} value={m.id}>{m.name} · {m.email}</option>)}
          </select>
        ) : null}
        <button className="hov" disabled={!others} onClick={revokeAll} style={{ ...smallBtn, color: 'var(--danger)' }}>{self ? 'Revoke all others' : 'Revoke all'}</button>
      </Head>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : list.length === 0 ? (
          <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-muted)' }}>No live sessions.</div>
        ) : list.map((s, i) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 42, borderTop: i ? '1px solid var(--border-subtle)' : 'none',
            background: s.mfaPending ? 'color-mix(in oklab, var(--state-running) 8%, transparent)' : 'transparent' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', flex: 'none', background: s.current ? 'var(--state-success)' : 'var(--text-muted)' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13, lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.userAgent}>{s.current ? 'This device · ' : ''}{s.device}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.ip ?? 'unknown ip'} · {s.auth === 'sso' ? 'SSO' : s.auth}{s.mfaPending ? ' · waiting for MFA code' : ''} · signed in {dateTime(s.createdAt)}
              </span>
            </div>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{s.current ? 'now' : ago(s.lastSeenAt)}</span>
            <button onClick={() => (s.current ? null : revoke(s))} className={s.current ? undefined : 'hov-text'}
              style={{ fontSize: 11, whiteSpace: 'nowrap', color: s.current ? 'var(--text-muted)' : 'var(--text-secondary)', cursor: s.current ? 'default' : 'pointer' }}>{s.current ? 'current' : 'revoke'}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── API tokens ──────────────────────────────────────────────────────────────

const tokT = '168px 110px minmax(160px,1fr) 118px 150px';

function NewToken({ max, onClose }: { max: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [exp, setExp] = useState<'30d' | '90d' | '365d' | 'never'>('90d');
  const m = useMutation({
    mutationFn: () => api.post('/security/tokens', { name, scopes, expiresDays: exp === 'never' ? null : Number(exp.replace('d', '')) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['security', 'tokens'] }),
  });
  return (
    <Modal title={m.data ? 'Token created' : 'New API token'} onClose={onClose} width={520}
      footer={m.data ? <><span className="spacer" /><Button variant="primary" onClick={onClose}>Done</Button></> : (
        <><span className="spacer" /><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || !scopes.length || m.isPending} onClick={() => m.mutate()}>Create token</Button></>
      )}>
      {m.data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Copy value={m.data.token} />
          <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>Copy it now — Comb stores only a hash and will never show it again. Send it as <span className="mono">Authorization: Bearer …</span>.</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <Label>Name</Label>
            <TextInput autoFocus mono value={name} onChange={(e) => setName(e.target.value)} placeholder="grafana_metrics" maxLength={60} />
          </label>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <Label>Scopes</Label>
              <div style={{ display: 'flex', gap: 6 }}>
                {['read', 'write', 'admin'].map((s) => {
                  const on = scopes.includes(s);
                  const allowed = max.includes(s);
                  return (
                    <button key={s} disabled={!allowed} title={allowed ? undefined : 'Your role cannot hold this scope'} onClick={() => setScopes(on ? scopes.filter((x) => x !== s) : [...scopes, s])}
                      style={{ ...cond, height: 24, padding: '0 9px', borderRadius: 3, border: '1px solid ' + (on ? 'var(--text-secondary)' : 'var(--border-subtle)'), background: on ? 'var(--bg-selected)' : 'transparent',
                        color: on ? (s === 'read' ? 'var(--text-primary)' : 'var(--state-running)') : 'var(--text-muted)' }}>{s}</button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <Label>Expires</Label>
              <Seg options={['30d', '90d', '365d', 'never'] as const} value={exp} onChange={setExp} />
            </div>
          </div>
          <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>A token never exceeds your role, and its connection access is capped by its scopes. Read-only tokens cannot change anything.</span>
          {m.error ? <Callout kind="error" title={errText(m.error)} /> : null}
        </div>
      )}
    </Modal>
  );
}

function Tokens() {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['security', 'tokens'], queryFn: () => api.get<{ tokens: Token[]; maxScopes: string[] }>('/security/tokens') });
  const revoke = async (t: Token) => {
    try {
      await api.del('/security/tokens/' + t.id);
      toast('Revoked ' + t.name, 'Any request with that token now gets 401. This cannot be undone.', 'success');
      void qc.invalidateQueries({ queryKey: ['security', 'tokens'] });
    } catch (e) { toast(errText(e), undefined, 'error'); }
  };
  const list = q.data?.tokens ?? [];
  const soon = (t: Token) => !!t.expiresAt && new Date(t.expiresAt).getTime() - Date.now() < 14 * 86400_000;
  const stale = (t: Token) => !t.lastUsedAt ? Date.now() - new Date(t.createdAt).getTime() > 30 * 86400_000 : Date.now() - new Date(t.lastUsedAt).getTime() > 60 * 86400_000;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Head label="API tokens">
        <button className="hov" onClick={() => setCreating(true)} style={smallBtn}>+ New token</button>
      </Head>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: tokT, minWidth: 760, background: 'var(--bg-inset)', borderBottom: list.length ? '1px solid var(--border-strong)' : 'none', ...cond, color: 'var(--text-muted)' }}>
          <div style={headCell}>Name</div><div style={headCell}>Prefix</div><div style={headCell}>Scopes</div><div style={headCell}>Last used</div><div style={{ padding: '5px 10px' }}>Expires</div>
        </div>
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : list.length === 0 ? (
          <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-muted)' }}>No tokens. Scripts and CI use a token instead of your password; each one can be revoked on its own.</div>
        ) : list.map((t, i) => (
          <div key={t.id} className="row-hover" style={{ display: 'grid', gridTemplateColumns: tokT, minWidth: 760, height: 38, borderBottom: i < list.length - 1 ? '1px solid var(--border-subtle)' : 'none',
            background: stale(t) ? 'color-mix(in oklab, var(--state-running) 8%, transparent)' : undefined, opacity: t.expired ? 0.55 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)' }}>{t.prefix}…</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 8px', borderRight: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
              {t.scopes.map((s) => <span key={s} style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', padding: '0 5px', border: '1px solid var(--border-strong)', borderRadius: 3, whiteSpace: 'nowrap', color: s === 'read' ? 'var(--text-secondary)' : 'var(--state-running)' }}>{s}</span>)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>{t.lastUsedAt ? ago(t.lastUsedAt) : 'never'}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px' }}>
              <span style={{ fontFamily: MONO, fontSize: 12, whiteSpace: 'nowrap', color: t.expired ? 'var(--state-error)' : !t.expiresAt ? 'var(--state-error)' : soon(t) ? 'var(--state-running)' : 'var(--text-secondary)' }}
                title={!t.expiresAt ? 'Never expires — the riskiest kind of token' : undefined}>{t.expired ? 'expired' : t.expiresAt ? t.expiresAt.slice(0, 10) : 'never'}</span>
              <span className="spacer" />
              <button onClick={() => revoke(t)} style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--danger)'; }} onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}>revoke</button>
            </div>
          </div>
        ))}
      </div>
      {creating && q.data ? <NewToken max={q.data.maxScopes} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

// ── IP allowlist + policy ───────────────────────────────────────────────────

function IpAllowlist() {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [cidr, setCidr] = useState('');
  const [note, setNote] = useState('');
  const [lockout, setLockout] = useState<{ action: 'add' | 'remove'; cidr: string; note?: string; message: string } | null>(null);
  const q = useQuery({ queryKey: ['security', 'ip'], queryFn: () => api.get<IpView>('/security/ip') });
  const apply = async (action: 'add' | 'remove', c: string, n = '', confirmLockout = false) => {
    try {
      const r = action === 'add' ? await api.post<IpView>('/security/ip', { cidr: c, note: n, confirmLockout }) : await api.del<IpView>('/security/ip', { cidr: c, confirmLockout });
      qc.setQueryData(['security', 'ip'], r);
      if (action === 'add') { setCidr(''); setNote(''); }
      setLockout(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body?.lockout) setLockout({ action, cidr: c, note: n, message: e.message });
      else toast(errText(e), undefined, 'error');
    }
  };
  const v = q.data;
  const add = () => { if (cidr.trim()) void apply('add', cidr.trim(), note.trim() || 'added ' + new Date().toISOString().slice(0, 10)); };
  let warn: string;
  let warnColor = 'var(--text-muted)';
  if (!v) warn = '';
  else if (!v.list.length) { warn = 'Empty allowlist means every address is allowed. That is the default, and it is the weakest setting on this page.'; warnColor = 'var(--state-running)'; }
  else if (v.yourIpListed) warn = `Requests from outside these ranges are refused before authentication. Your current address ${v.yourIp} is inside the list.`;
  else if (v.yourIpAllowed) { warn = `Your current address ${v.yourIp} is not in any range; you get in only because COMB_ALLOWLIST_LOOPBACK_BYPASS is on for this server.`; warnColor = 'var(--state-running)'; }
  else { warn = `Your current address ${v.yourIp} is outside every range.`; warnColor = 'var(--state-error)'; }
  return (
    <div style={{ flex: 1, minWidth: 300, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="label">IP allowlist</span>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, padding: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : null}
        {v?.list.length ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {v.list.map((e) => (
              <span key={e.cidr} style={{ display: 'flex', alignItems: 'center', gap: 7, height: 24, padding: '0 8px', border: '1px solid var(--border-subtle)', borderRadius: 3, fontFamily: MONO, fontSize: 12 }}>
                {e.cidr}{e.note ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{e.note}</span> : null}
                <button onClick={() => apply('remove', e.cidr)} title="Remove" style={{ fontSize: 11, color: 'var(--text-muted)' }}>✕</button>
              </span>
            ))}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={cidr} onChange={(e) => setCidr(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder="10.0.0.0/8"
            style={{ flex: 1, minWidth: 0, height: 26, padding: '0 9px', background: 'var(--bg-raised)', border: '1px solid var(--border-strong)', borderRadius: 3, fontFamily: MONO, fontSize: 12 }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder="note" maxLength={80}
            style={{ width: 110, height: 26, padding: '0 9px', background: 'var(--bg-raised)', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 12 }} />
          <button className="hov" onClick={add} style={{ ...smallBtn, height: 26, padding: '0 10px' }}>Add</button>
        </div>
        <div style={{ fontSize: 12, lineHeight: '17px', color: warnColor }}>{warn}</div>
        <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--text-muted)' }}>
          Loopback is not exempt unless the server runs with COMB_ALLOWLIST_LOOPBACK_BYPASS=true. Locked out? Run <span className="mono">npm -w server run allowlist:clear</span> on the server.
        </div>
      </div>
      {lockout ? (
        <Modal title="This would lock you out" onClose={() => setLockout(null)} width={480}
          footer={<><span className="spacer" /><Button variant="ghost" onClick={() => setLockout(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => apply(lockout.action, lockout.cidr, lockout.note, true)}>{lockout.action === 'add' ? 'Add anyway' : 'Remove anyway'}</Button></>}>
          <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--text-secondary)' }}>{lockout.message}</div>
        </Modal>
      ) : null}
    </div>
  );
}

const IDLE: Array<[string, number]> = [['15m', 15], ['1h', 60], ['8h', 480], ['24h', 1440]];

function PolicyPanel() {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const q = useQuery({ queryKey: ['security', 'policy'], queryFn: () => api.get<Policy>('/security/policy') });
  const set = async (patch: Partial<Policy>) => {
    try {
      const r = await api.patch<Policy>('/security/policy', patch);
      qc.setQueryData(['security', 'policy'], (old: Policy | undefined) => ({ ...(old as Policy), ...r }));
      void qc.invalidateQueries({ queryKey: ['security', 'me'] });
    } catch (e) { toast(errText(e), undefined, 'error'); }
  };
  const p = q.data;
  const rows: Array<[keyof Policy, string, string, boolean?]> = p ? [
    ['requireMfa', 'Require MFA for every member', 'Interactive sign-ins must enroll an authenticator before doing anything else. Tokens are not affected.'],
    ['ssoOnly', 'Block password auth', p.ssoEnabled ? 'SSO only. Owners keep password sign-in as the break-glass path.' : 'Turn on single sign-on in Team & access first.', !p.ssoEnabled && !p.ssoOnly],
    ['blockExportOnProd', 'Block exports from prod', 'CSV export is refused on connections marked prod.'],
  ] : [];
  const idle = IDLE.find(([, m]) => m === p?.sessionIdleMinutes)?.[0] ?? '8h';
  return (
    <div style={{ flex: 1, minWidth: 300, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="label">Policy</span>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, padding: 10, display: 'flex', flexDirection: 'column', gap: 11 }}>
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : null}
        {rows.map(([k, label, hint, disabled]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}><span style={{ fontSize: 13, lineHeight: '18px' }}>{label}</span><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</span></div>
            <Toggle on={!!p?.[k]} disabled={disabled} onChange={(v) => set({ [k]: v } as Partial<Policy>)} />
          </div>
        ))}
        {p ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, paddingTop: 9, borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}><span style={{ fontSize: 13, lineHeight: '18px' }}>Idle session timeout</span><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Applies to the workspace UI, not to open database connections.</span></div>
            <Seg options={IDLE.map(([l]) => l)} value={idle} onChange={(l) => set({ sessionIdleMinutes: IDLE.find(([x]) => x === l)![1] })} />
          </div>
        ) : null}
        <span style={{ fontSize: 11, lineHeight: '16px', color: 'var(--text-muted)' }}>Approval for prod writes is set per connection; statement safety rules live in Settings → Safety.</span>
      </div>
    </div>
  );
}

// ── Your account: two-factor + password ─────────────────────────────────────

function TwoFactor({ me }: { me: MeSec }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'idle' | 'disable'>('idle');
  const [err, setErr] = useState<unknown>(null);
  const done = () => { setSetup(null); setCode(''); setMode('idle'); setErr(null); void qc.invalidateQueries({ queryKey: ['security'] }); void qc.invalidateQueries({ queryKey: ['team'] }); };
  const start = async () => { setErr(null); try { setSetup(await api.post('/security/mfa/setup')); } catch (e) { setErr(e); } };
  const enable = async () => {
    try {
      const r = await api.post('/security/mfa/enable', { code });
      if (r?.csrfToken) setCsrf(r.csrfToken);
      toast('Two-factor is on', 'Your session was renewed. Next sign-in asks for a code.', 'success');
      done();
    } catch (e) { setErr(e); }
  };
  const disable = async () => {
    try {
      await api.post('/security/mfa/disable', { code });
      toast('Two-factor is off', undefined, 'success');
      done();
    } catch (e) { setErr(e); }
  };
  const codeInput = (
    <TextInput value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" mono style={{ width: 130 }}
      onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) void (setup ? enable() : disable()); }} />
  );
  return (
    <div style={{ flex: 1, minWidth: 300, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="label">Two-factor</span>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...cond, padding: '1px 5px', background: me.mfaEnabled ? 'var(--state-success)' : 'transparent', color: me.mfaEnabled ? 'var(--text-inverse)' : 'var(--text-muted)', border: me.mfaEnabled ? 'none' : '1px solid var(--border-strong)' }}>
            {me.mfaEnabled ? 'ON' : 'OFF'}
          </span>
          <span style={{ fontSize: 13 }}>Authenticator app (TOTP)</span>
          <span className="spacer" />
          {me.via !== 'session' ? null : me.mfaEnabled ? (
            mode === 'idle' ? <button className="hov" disabled={me.requireMfa} title={me.requireMfa ? 'Workspace policy requires two-factor' : undefined} onClick={() => setMode('disable')} style={smallBtn}>Turn off</button> : null
          ) : !setup ? <button className="hov" onClick={start} style={smallBtn}>Set up</button> : null}
        </div>
        {setup ? (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            {setup.qrDataUrl.startsWith('data:image/png;base64,') ? <img src={setup.qrDataUrl} alt="Authenticator QR code" width={132} height={132} style={{ background: '#fff', padding: 6, borderRadius: 3, flex: 'none' }} /> : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)' }}>Scan with an authenticator app, or type this key:</span>
              <span style={{ fontFamily: MONO, fontSize: 12, wordBreak: 'break-all' }}>{setup.secret}</span>
              <div style={{ display: 'flex', gap: 6 }}>{codeInput}<Button variant="primary" disabled={code.length !== 6} onClick={enable}>Turn on</Button><Button variant="ghost" onClick={() => { setSetup(null); setCode(''); }}>Cancel</Button></div>
            </div>
          </div>
        ) : mode === 'disable' ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {codeInput}<Button variant="danger-ghost" disabled={code.length !== 6} onClick={disable}>Turn off two-factor</Button><Button variant="ghost" onClick={() => { setMode('idle'); setCode(''); }}>Cancel</Button>
          </div>
        ) : (
          <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>
            {me.mfaEnabled ? (me.requireMfa ? 'Required by workspace policy.' : 'Every password or SSO sign-in asks for a code from your app.') : 'A stolen password alone is enough to sign in as you. A code from your phone fixes that.'}
          </span>
        )}
        {err ? <Callout kind="error" title={errText(err)} /> : null}
      </div>
    </div>
  );
}

function Password({ me }: { me: MeSec }) {
  const toast = useApp((s) => s.toast);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/security/password', { current: cur, next }),
    onSuccess: () => { setCur(''); setNext(''); toast('Password changed', 'Every other session was signed out.', 'success'); },
  });
  return (
    <div style={{ flex: 1, minWidth: 300, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="label">Password</span>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, padding: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {!me.hasPassword ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>You sign in with single sign-on; there is no Comb password to change.</span> : (
          <>
            <TextInput type="password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="Current password" autoComplete="current-password" />
            <TextInput type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (12+ characters)" autoComplete="new-password" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Other sessions are signed out.</span>
              <span className="spacer" />
              <Button size="sm" variant="primary" disabled={!cur || next.length < 12 || m.isPending} onClick={() => m.mutate()}>Change password</Button>
            </div>
            {m.error ? <Callout kind="error" title={errText(m.error)} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

export default function SecurityScreen({ tab }: { tab: Tab }) {
  void tab;
  const me = useQuery({ queryKey: ['security', 'me'], queryFn: () => api.get<MeSec>('/security/me') });
  const admin = isAdmin(me.data?.role);
  return (
    <div className="screen">
      <div style={{ padding: '18px 20px 50px', maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 20, lineHeight: '26px', fontWeight: 600 }}>Security</div>
          <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--text-secondary)' }}>Everything on this page narrows what a stolen credential can reach.</div>
        </div>
        {me.isLoading ? <Loading /> : me.error ? <ErrorBox error={me.error} onRetry={() => me.refetch()} /> : me.data ? (
          <>
            <Sessions me={me.data} />
            <Tokens />
            {admin ? (
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <IpAllowlist />
                <PolicyPanel />
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <TwoFactor me={me.data} />
              <Password me={me.data} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
