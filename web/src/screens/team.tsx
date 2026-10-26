import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessLevel, WorkspaceRole } from '@comb/shared';
import type { Tab } from '../lib/store.ts';
import { useApp } from '../lib/store.ts';
import { api, ApiError } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { Button, Seg, Toggle, TextInput, Modal, Loading, ErrorBox, Callout, Label, IDC, COND, MONO } from '../ui/index.tsx';

/* Team & access (mockup isTeamTab). The server enforces every rule; this screen only mirrors them. */

interface Conn { id: string; name: string; color: string; env: string }
interface Member {
  id: string; email: string; name: string; role: WorkspaceRole; auth: 'password' | 'sso' | 'token'; mfa: boolean; status: 'active' | 'invited' | 'disabled';
  lastActive: string | null; inviteExpires: string | null; tokens: number; me: boolean;
  access: Record<string, { level: AccessLevel; explicit: boolean }>;
}
interface TeamData { me: { id: string; role: WorkspaceRole }; connections: Conn[]; members: Member[]; counts: { active: number; invited: number; service: number; disabled: number } }
interface SsoView {
  enabled: boolean; provider: 'saml' | 'oidc'; label: string;
  saml: { entryPoint: string; idpIssuer: string; cert: string; metadataUrl: string };
  oidc: { issuer: string; clientId: string; scopes: string };
  groupsAttribute: string; domains: string[]; jit: boolean; syncGroups: boolean; requireMfaClaim: boolean; allowPrivateNetwork: boolean;
  groupMap: Array<{ group: string; role: WorkspaceRole }>;
  acsUrl: string; spEntityId: string; oidcRedirectUrl: string; hasClientSecret: boolean; ssoOnly: boolean;
}

const LEVELS: AccessLevel[] = ['none', 'read', 'write', 'admin'];
const ROLE_MENU: WorkspaceRole[] = ['Viewer', 'Analyst', 'Admin', 'Owner'];
const cond: CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' };
const headCell: CSSProperties = { padding: '5px 10px', borderRight: '1px solid var(--border-subtle)' };
const roleColor = (r: string) => r === 'Owner' ? 'var(--danger)' : r === 'Admin' ? 'var(--state-running)' : r === 'Service' ? 'var(--type-identifier)' : r === 'Viewer' ? 'var(--text-muted)' : 'var(--state-info)';
const levelColor = (l: AccessLevel) => l === 'none' ? 'var(--text-muted)' : l === 'read' ? 'var(--state-info)' : l === 'write' ? 'var(--state-running)' : 'var(--danger)';
const errText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

function SectionHead({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

function Track({ on, onClick, disabled, title }: { on: boolean; onClick: () => void; disabled?: boolean; title?: string }) {
  return <Toggle on={on} onChange={() => onClick()} disabled={disabled} title={title} />;
}

function CopyOnce({ value, note }: { value: string; note: ReactNode }) {
  const toast = useApp((s) => s.toast);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()}
          style={{ flex: 1, height: 28, padding: '0 9px', border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', fontFamily: MONO, fontSize: 12 }} />
        <Button onClick={() => { void navigator.clipboard?.writeText(value).then(() => toast('Copied', undefined, 'success')).catch(() => toast('Copy failed — select the text and copy it', undefined, 'error')); }}>Copy</Button>
      </div>
      <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>{note}</div>
    </div>
  );
}

// ── Invite / service identity dialog ────────────────────────────────────────

function InviteModal({ myRole, onClose }: { myRole: WorkspaceRole; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'person' | 'service'>('person');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('Analyst');
  const [svc, setSvc] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [expiry, setExpiry] = useState<'30d' | '90d' | '365d' | 'never'>('90d');
  const [result, setResult] = useState<{ link?: string; token?: string; email: string; expiresAt: string | null } | null>(null);
  const roles: WorkspaceRole[] = myRole === 'Owner' ? ['Viewer', 'Analyst', 'Admin', 'Owner'] : ['Viewer', 'Analyst'];
  const m = useMutation({
    mutationFn: async () => kind === 'person'
      ? api.post('/team/invite', { email, role })
      : api.post('/team/service', { name: svc, scopes, expiresDays: expiry === 'never' ? null : Number(expiry.replace('d', '')) }),
    onSuccess: (r) => { setResult(r); void qc.invalidateQueries({ queryKey: ['team'] }); },
  });
  return (
    <Modal title={result ? (kind === 'person' ? 'Invite link' : 'Service token') : 'Invite'} onClose={onClose} width={520}
      footer={result ? <><span className="spacer" /><Button variant="primary" onClick={onClose}>Done</Button></> : (
        <>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={m.isPending || (kind === 'person' ? !/^\S+@\S+\.\S+$/.test(email) : svc.length < 2 || !scopes.length)} onClick={() => m.mutate()}>
            {kind === 'person' ? 'Create invite link' : 'Create service identity'}
          </Button>
        </>
      )}>
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {result.link ? (
            <CopyOnce value={result.link} note={<>Comb does not send email. Send this link to <span className="mono">{result.email}</span> yourself. It works once, expires in 7 days, and this is the only time it is shown.</>} />
          ) : (
            <CopyOnce value={result.token!} note={<>Copy it now — Comb stores only a hash and will never show it again. <span className="mono">{result.email}</span> sees no connection until you grant one in the access matrix.</>} />
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Seg options={['person', 'service'] as const} value={kind} onChange={setKind} labels={{ person: 'Person', service: 'Service identity' }} />
          {kind === 'person' ? (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <Label>Email</Label>
                <TextInput autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" type="email" />
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <Label>Workspace role</Label>
                <Seg options={roles} value={role} onChange={setRole} />
                {myRole !== 'Owner' ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Only Owners can invite Admins and Owners.</span> : null}
              </div>
              <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>Comb does not send email. You get a one-time link to pass on yourself; it expires in 7 days.</span>
            </>
          ) : (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <Label>Name</Label>
                <TextInput autoFocus mono value={svc} onChange={(e) => setSvc(e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ''))} placeholder="svc_export" />
              </label>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <Label>Scopes</Label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {['read', 'write'].map((s) => {
                      const on = scopes.includes(s);
                      return (
                        <button key={s} onClick={() => setScopes(on ? scopes.filter((x) => x !== s) : [...scopes, s])}
                          style={{ ...cond, height: 24, padding: '0 9px', borderRadius: 3, border: '1px solid ' + (on ? 'var(--text-secondary)' : 'var(--border-subtle)'), background: on ? 'var(--bg-selected)' : 'transparent', color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>{s}</button>
                      );
                    })}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <Label>Expires</Label>
                  <Seg options={['30d', '90d', '365d', 'never'] as const} value={expiry} onChange={setExpiry} />
                </div>
              </div>
              <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>Service identities sign in with a token only, use no seat, and start with no connection access.</span>
            </>
          )}
          {m.error ? <Callout kind="error" title={errText(m.error)} /> : null}
        </div>
      )}
    </Modal>
  );
}

function ConfirmRemove({ member, onClose }: { member: Member; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const m = useMutation({
    mutationFn: () => api.del(`/team/members/${member.id}`),
    onSuccess: (r) => {
      toast(member.status === 'invited' ? 'Invite cancelled' : 'Removed ' + member.name, member.status === 'invited' ? undefined : `${r.sessionsRevoked} session(s) and ${r.tokensRevoked} token(s) revoked. The audit trail keeps their history.`, 'success');
      void qc.invalidateQueries({ queryKey: ['team'] });
      onClose();
    },
  });
  return (
    <Modal title={member.status === 'invited' ? `Cancel the invite for ${member.email}?` : `Remove ${member.name}?`} onClose={onClose} width={460}
      footer={<><span className="spacer" /><Button variant="ghost" onClick={onClose}>Keep</Button><Button variant="danger" disabled={m.isPending} onClick={() => m.mutate()}>{member.status === 'invited' ? 'Cancel invite' : 'Remove'}</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: '19px', color: 'var(--text-secondary)' }}>
        <span>Their sessions and API tokens are revoked immediately. The account is disabled, not deleted, so the audit trail keeps who did what. You can restore it later.</span>
        {m.error ? <Callout kind="error" title={errText(m.error)} /> : null}
      </div>
    </Modal>
  );
}

// ── Members ─────────────────────────────────────────────────────────────────

const memT = '210px 122px 118px 140px 116px minmax(156px,1fr)';

function Members({ data }: { data: TeamData }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const set = useApp((s) => s.set);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [link, setLink] = useState<{ link: string; email: string } | null>(null);
  const isOwner = data.me.role === 'Owner';

  const act = async (fn: () => Promise<unknown>, ok: string, sub?: string) => {
    try {
      await fn();
      toast(ok, sub, 'success');
      void qc.invalidateQueries({ queryKey: ['team'] });
    } catch (e) {
      toast(errText(e), undefined, 'error');
    }
  };

  const roleMenu = (m: Member, x: number, y: number) => {
    if (m.role === 'Service') return toast('Service identities have fixed scope', 'Rotate or revoke its token instead.', 'info');
    if (m.me) return toast('You cannot change your own role', 'Ask another Owner.', 'info');
    const allowed = isOwner ? ROLE_MENU : ['Viewer', 'Analyst'];
    set({
      ctxMenu: {
        x, y,
        items: [
          ...ROLE_MENU.filter((r) => r !== m.role).map((r) => ({
            label: (allowed.includes(r) ? '' : '⊘ ') + 'Make ' + r,
            onClick: () => act(() => api.patch(`/team/members/${m.id}`, { role: r }), `${m.name} → ${r}`, 'Takes effect on their next request.'),
          })),
          ...(m.mfa && m.status === 'active' ? [{ label: 'Reset two-factor', sep: true, onClick: () => act(() => api.post(`/team/members/${m.id}/reset-mfa`), 'Two-factor reset for ' + m.name, 'Their sessions were signed out. They enroll again on next sign-in if policy requires it.') }] : []),
        ],
      },
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionHead label="Members">
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>
          {data.counts.active} active · {data.counts.invited} invited · {data.counts.service} service identit{data.counts.service === 1 ? 'y' : 'ies'}{data.counts.disabled ? ` · ${data.counts.disabled} removed` : ''}
        </span>
      </SectionHead>
      {link ? <CopyOnce value={link.link} note={<>New invite link for <span className="mono">{link.email}</span>. Comb does not send email — send it yourself. Works once, expires in 7 days.</>} /> : null}
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: memT, minWidth: 860, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...cond, color: 'var(--text-muted)' }}>
          <div style={headCell}>Member</div><div style={headCell}>Workspace role</div><div style={headCell}>Auth</div>
          <div style={headCell}>Connections</div><div style={headCell}>Last active</div><div style={{ padding: '5px 10px' }}>Status</div>
        </div>
        {data.members.map((m, i) => {
          const granted = data.connections.filter((c) => m.access[c.id]?.level !== 'none').length;
          const dim = m.status === 'disabled';
          return (
            <div key={m.id} className="row-hover" style={{ display: 'grid', gridTemplateColumns: memT, minWidth: 860, height: 42, borderBottom: i < data.members.length - 1 ? '1px solid var(--border-subtle)' : 'none', opacity: dim ? 0.55 : 1 }}>
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
                <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}{m.me ? <span style={{ color: 'var(--text-muted)' }}> · you</span> : null}</span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.email}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', borderRight: '1px solid var(--border-subtle)' }}>
                <button disabled={dim} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); roleMenu(m, r.left, r.bottom + 2); }}
                  style={{ ...cond, height: 22, padding: '0 8px', border: '1px solid var(--border-strong)', borderRadius: 3, color: roleColor(m.role) }}>
                  {m.role}{m.role !== 'Service' && !m.me ? ' ▾' : ''}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderRight: '1px solid var(--border-subtle)' }}>
                <span style={{ ...cond, color: m.auth === 'password' ? 'var(--state-running)' : 'var(--text-secondary)' }}>{m.auth === 'sso' ? 'SSO' : m.auth}</span>
                {m.mfa ? <span title="Two-factor on" style={{ fontSize: 10, color: 'var(--state-success)' }}>◆</span> : null}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '0 10px', borderRight: '1px solid var(--border-subtle)' }}>
                {data.connections.slice(0, 12).map((c) => (
                  <span key={c.id} title={`${c.name}: ${m.access[c.id]?.level}`} style={{ width: 6, height: 6, borderRadius: '50%', flex: 'none', background: IDC[c.color] ?? IDC.slate, opacity: m.access[c.id]?.level !== 'none' ? 1 : 0.22 }} />
                ))}
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>{granted}/{data.connections.length}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>
                {m.status === 'invited' ? (m.inviteExpires ? 'link ' + (new Date(m.inviteExpires) > new Date() ? 'valid' : 'expired') : '—') : m.lastActive ? ago(m.lastActive) : '—'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px' }}>
                <span style={{ ...cond, color: m.status === 'invited' ? 'var(--state-running)' : m.status === 'disabled' ? 'var(--text-muted)' : 'var(--state-success)' }}>{m.status === 'disabled' ? 'removed' : m.status}</span>
                <span className="spacer" />
                {m.me ? null : m.status === 'disabled' ? (
                  <button className="hov-text" onClick={() => act(() => api.patch(`/team/members/${m.id}`, { status: 'active' }), `${m.name} restored`, 'They sign in again with their old credentials. Tokens stay revoked.')}
                    style={{ fontSize: 11, color: 'var(--text-muted)' }}>restore</button>
                ) : (
                  <>
                    {m.status === 'invited' ? (
                      <button className="hov-text" style={{ fontSize: 11, color: 'var(--text-muted)' }}
                        onClick={async () => { try { const r = await api.post(`/team/members/${m.id}/resend`); setLink({ link: r.link, email: r.email }); void qc.invalidateQueries({ queryKey: ['team'] }); } catch (e) { toast(errText(e), undefined, 'error'); } }}>resend</button>
                    ) : null}
                    <button onClick={() => setRemoving(m)} style={{ fontSize: 11, color: 'var(--text-muted)' }} onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--danger)'; }} onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}>
                      {m.status === 'invited' ? 'cancel' : 'remove'}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {removing ? <ConfirmRemove member={removing} onClose={() => setRemoving(null)} /> : null}
    </div>
  );
}

// ── SSO ─────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ minWidth: 0, display: 'flex', gap: 6 }}>{children}</div>
    </>
  );
}
const inputStyle: CSSProperties = { height: 26, width: '100%', padding: '0 9px', background: 'var(--bg-raised)', border: '1px solid var(--border-strong)', borderRadius: 3, fontFamily: MONO, fontSize: 12, minWidth: 0 };
const roStyle: CSSProperties = { ...inputStyle, display: 'flex', alignItems: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)', background: 'var(--bg-inset)' };

function SsoPanels({ sso, isOwner }: { sso: SsoView; isOwner: boolean }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [d, setD] = useState<SsoView>(sso);
  const [secret, setSecret] = useState('');
  const [domain, setDomain] = useState('');
  const [grp, setGrp] = useState('');
  const [grpRole, setGrpRole] = useState<WorkspaceRole>('Viewer');
  const [importing, setImporting] = useState(false);
  useEffect(() => setD(sso), [sso]);
  const dirty = JSON.stringify(d) !== JSON.stringify(sso) || secret !== '';
  const ro = !isOwner;

  const save = useMutation({
    mutationFn: (next: SsoView) => api.put('/team/sso', { ...next, ...(secret ? { clientSecret: secret } : {}) }),
    onSuccess: (r) => {
      setSecret('');
      qc.setQueryData(['team', 'sso'], r);
      void qc.invalidateQueries({ queryKey: ['team'] });
      toast('Single sign-on saved', r.enabled ? 'New sign-ins use it right away. Existing sessions are not touched.' : undefined, 'success');
    },
    onError: (e) => toast(errText(e), undefined, 'error'),
  });
  const patch = (p: Partial<SsoView>) => setD((x) => ({ ...x, ...p }));
  const importMeta = async () => {
    setImporting(true);
    try {
      const r = await api.post('/team/sso/metadata', { url: d.saml.metadataUrl, allowPrivateNetwork: d.allowPrivateNetwork });
      patch({ saml: { ...d.saml, entryPoint: r.entryPoint || d.saml.entryPoint, idpIssuer: r.idpIssuer || d.saml.idpIssuer, cert: r.cert || d.saml.cert } });
      toast('Metadata read', 'Sign-on URL, entity ID and certificate filled in. Review, then save.', 'success');
    } catch (e) {
      toast(errText(e), undefined, 'error');
    } finally {
      setImporting(false);
    }
  };

  const toggles: Array<[keyof SsoView, string, string, boolean?]> = [
    ['ssoOnly', 'Enforce SSO only', 'Password sign-in stops working for everyone except Owners (their break-glass path).', !d.enabled],
    ['jit', 'Just-in-time provisioning', 'Create the member on first successful sign-in.'],
    ['syncGroups', 'Sync role from groups', 'Each sign-in applies the group mapping. Owners are never demoted this way.'],
    ['requireMfaClaim', 'Require MFA claim', 'Reject sign-ins the IdP does not mark as multi-factor (amr / AuthnContext).'],
  ];
  const providerLabel = (d.provider === 'saml' ? 'SAML 2.0' : 'OIDC') + (d.label ? ' · ' + d.label : '');

  return (
    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span className="label">Single sign-on</span>
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ ...cond, padding: '1px 5px', background: sso.enabled ? 'var(--state-success)' : 'transparent', color: sso.enabled ? 'var(--text-inverse)' : 'var(--text-muted)', border: sso.enabled ? 'none' : '1px solid var(--border-strong)' }}>
              {sso.enabled ? 'ENABLED' : 'DISABLED'}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>{providerLabel}</span>
            <span className="spacer" />
            <Track on={d.enabled} disabled={ro} onClick={() => patch({ enabled: !d.enabled, ...(d.enabled ? { ssoOnly: false } : {}) })} title="Turn single sign-on on or off" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', alignItems: 'center' }}>
            <Field label="Protocol">
              {ro ? <span style={roStyle}>{d.provider === 'saml' ? 'SAML 2.0' : 'OIDC'}</span>
                : <Seg options={['saml', 'oidc'] as const} value={d.provider} onChange={(v) => patch({ provider: v })} labels={{ saml: 'SAML 2.0', oidc: 'OIDC' }} />}
              <input disabled={ro} value={d.label} onChange={(e) => patch({ label: e.target.value })} placeholder="IdP name, e.g. Okta" style={{ ...inputStyle, fontFamily: 'inherit' }} />
            </Field>
            {d.provider === 'saml' ? (
              <>
                <Field label="IdP metadata">
                  <input disabled={ro} value={d.saml.metadataUrl} onChange={(e) => patch({ saml: { ...d.saml, metadataUrl: e.target.value } })} placeholder="https://acme.okta.com/app/…/sso/saml/metadata" style={inputStyle} />
                  {ro ? null : <Button size="sm" style={{ height: 26 }} disabled={!d.saml.metadataUrl || importing} onClick={importMeta}>Import</Button>}
                </Field>
                <Field label="Sign-on URL"><input disabled={ro} value={d.saml.entryPoint} onChange={(e) => patch({ saml: { ...d.saml, entryPoint: e.target.value } })} placeholder="https://idp/…/sso/saml" style={inputStyle} /></Field>
                <Field label="IdP entity ID"><input disabled={ro} value={d.saml.idpIssuer} onChange={(e) => patch({ saml: { ...d.saml, idpIssuer: e.target.value } })} placeholder="http://www.okta.com/exk…" style={inputStyle} /></Field>
                <Field label="Certificate">
                  <textarea disabled={ro} value={d.saml.cert} onChange={(e) => patch({ saml: { ...d.saml, cert: e.target.value } })} placeholder="-----BEGIN CERTIFICATE----- (IdP signing certificate)" rows={2}
                    style={{ ...inputStyle, height: 44, padding: '5px 9px', resize: 'vertical' }} />
                </Field>
                <Field label="ACS URL"><span style={roStyle} title={sso.acsUrl}>{sso.acsUrl}</span></Field>
                <Field label="SP entity ID"><span style={roStyle} title={sso.spEntityId}>{sso.spEntityId}</span></Field>
              </>
            ) : (
              <>
                <Field label="Issuer"><input disabled={ro} value={d.oidc.issuer} onChange={(e) => patch({ oidc: { ...d.oidc, issuer: e.target.value } })} placeholder="https://acme.okta.com" style={inputStyle} /></Field>
                <Field label="Client ID"><input disabled={ro} value={d.oidc.clientId} onChange={(e) => patch({ oidc: { ...d.oidc, clientId: e.target.value } })} style={inputStyle} /></Field>
                <Field label="Client secret">
                  <input disabled={ro} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={sso.hasClientSecret ? '•••••• stored — type to replace' : 'none (public client with PKCE)'} style={inputStyle} autoComplete="off" />
                </Field>
                <Field label="Redirect URL"><span style={roStyle} title={sso.oidcRedirectUrl}>{sso.oidcRedirectUrl}</span></Field>
              </>
            )}
            <Field label="Groups claim"><input disabled={ro} value={d.groupsAttribute} onChange={(e) => patch({ groupsAttribute: e.target.value })} style={inputStyle} /></Field>
            <Field label="Domains">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {d.domains.map((x) => (
                  <span key={x} style={{ height: 22, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', border: '1px solid var(--border-subtle)', borderRadius: 3, fontFamily: MONO, fontSize: 12 }}>
                    {x}{ro ? null : <button onClick={() => patch({ domains: d.domains.filter((y) => y !== x) })} style={{ fontSize: 11, color: 'var(--text-muted)' }}>✕</button>}
                  </span>
                ))}
                {ro ? (d.domains.length ? null : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>none</span>) : (
                  <input value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} placeholder="+ acme.com"
                    onKeyDown={(e) => { if (e.key === 'Enter' && domain && !d.domains.includes(domain)) { patch({ domains: [...d.domains, domain] }); setDomain(''); } }}
                    style={{ ...inputStyle, width: 120, height: 22 }} />
                )}
              </div>
            </Field>
          </div>
          {toggles.map(([k, label, hint, disabled]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}><span style={{ fontSize: 13, lineHeight: '18px' }}>{label}</span><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</span></div>
              <Track on={!!d[k]} disabled={ro || disabled} onClick={() => patch({ [k]: !d[k] } as Partial<SsoView>)} />
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}><span style={{ fontSize: 13, lineHeight: '18px' }}>IdP on a private network</span><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Allow private addresses for metadata and OIDC calls. Cloud metadata addresses stay blocked.</span></div>
            <Track on={d.allowPrivateNetwork} disabled={ro} onClick={() => patch({ allowPrivateNetwork: !d.allowPrivateNetwork })} />
          </div>
          {isOwner ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{dirty ? 'Unsaved changes' : 'Saved'}</span>
              <span className="spacer" />
              {dirty ? <Button size="sm" variant="ghost" onClick={() => { setD(sso); setSecret(''); }}>Discard</Button> : null}
              <Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(d)}>Save</Button>
            </div>
          ) : <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Only Owners change single sign-on: it decides who becomes what.</span>}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span className="label">IdP group → workspace role</span>
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
          {d.groupMap.map((g, i) => (
            <div key={g.group} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', height: 30, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
              <span style={{ fontFamily: MONO, fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.group}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>→</span>
              <span style={{ ...cond, color: roleColor(g.role), width: 64 }}>{g.role}</span>
              {ro ? null : <button onClick={() => patch({ groupMap: d.groupMap.filter((x) => x.group !== g.group) })} style={{ fontSize: 11, color: 'var(--text-muted)' }} title="Remove mapping">✕</button>}
            </div>
          ))}
          {d.groupMap.length === 0 ? <div style={{ padding: '9px 10px', fontSize: 12, color: 'var(--text-muted)' }}>No groups mapped yet.</div> : null}
          {ro ? null : (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '7px 10px', borderTop: '1px solid var(--border-subtle)' }}>
              <input value={grp} onChange={(e) => setGrp(e.target.value)} placeholder="+ map another group" style={{ ...inputStyle, height: 24, flex: 1 }}
                onKeyDown={(e) => { if (e.key === 'Enter' && grp.trim()) { patch({ groupMap: [...d.groupMap.filter((x) => x.group !== grp.trim()), { group: grp.trim(), role: grpRole }] }); setGrp(''); } }} />
              <select value={grpRole} onChange={(e) => setGrpRole(e.target.value as WorkspaceRole)} style={{ ...cond, height: 24, border: '1px solid var(--border-strong)', borderRadius: 3, padding: '0 4px', color: roleColor(grpRole), background: 'var(--bg-raised)' }}>
                {ROLE_MENU.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <Button size="sm" disabled={!grp.trim()} onClick={() => { patch({ groupMap: [...d.groupMap.filter((x) => x.group !== grp.trim()), { group: grp.trim(), role: grpRole }] }); setGrp(''); }}>Add</Button>
            </div>
          )}
        </div>
        <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>
          Unmapped groups get no access at all — a member who signs in without a mapped group lands on an empty launcher, not on someone else's production database. Paste the IdP group name exactly; mapping changes are saved with the SSO settings.
        </div>
      </div>
    </div>
  );
}

// ── Access matrix ───────────────────────────────────────────────────────────

function AccessMatrix({ data }: { data: TeamData }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const isOwner = data.me.role === 'Owner';
  const rows = data.members.filter((m) => m.status !== 'disabled');
  const accT = `150px repeat(${Math.max(1, data.connections.length)}, minmax(96px,1fr))`;
  const minW = 150 + 96 * Math.max(1, data.connections.length);

  const setLevel = async (m: Member, c: Conn, level: AccessLevel | null) => {
    try {
      await api.put('/team/access', { userId: m.id, connectionId: c.id, level });
      void qc.invalidateQueries({ queryKey: ['team'] });
      toast(`${m.name} · ${c.name} → ${level ?? 'role default'}`, undefined, 'success');
    } catch (e) {
      toast(errText(e), undefined, 'error');
    }
  };

  if (!data.connections.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionHead label="Connection access">
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>click to cycle none → read → write → admin · shift-click resets to the role default (muted)</span>
      </SectionHead>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: accT, minWidth: minW, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...cond, color: 'var(--text-muted)' }}>
          <div style={headCell}>Member</div>
          {data.connections.map((c) => (
            <div key={c.id} style={{ padding: '5px 8px', borderRight: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ width: 2, height: 12, flex: 'none', background: IDC[c.color] ?? IDC.slate }} />
              <span style={{ fontFamily: MONO, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>{c.name}</span>
            </div>
          ))}
        </div>
        {rows.map((m, i) => (
          <div key={m.id} className="row-hover" style={{ display: 'grid', gridTemplateColumns: accT, minWidth: minW, height: 30, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.email}>{m.name}</div>
            {data.connections.map((c) => {
              const cell = m.access[c.id] ?? { level: 'none' as AccessLevel, explicit: false };
              const locked = !isOwner && (m.me || m.role === 'Owner' || m.role === 'Admin' || cell.level === 'admin' && cell.explicit);
              const cycle = LEVELS.filter((l) => isOwner || l !== 'admin');
              const next = cycle[(cycle.indexOf(cell.level) + 1) % cycle.length] ?? 'none';
              return (
                <div key={c.id} title={locked ? 'Only an Owner can change this' : cell.explicit ? `${cell.level} (set explicitly) · shift-click to reset` : `${cell.level} (role default) · click to set`}
                  onClick={(e) => { if (locked) return void toast('Only an Owner can change this', undefined, 'info'); if (e.shiftKey) { if (cell.explicit) void setLevel(m, c, null); } else void setLevel(m, c, next); }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: '1px solid var(--border-subtle)', cursor: locked ? 'default' : 'pointer', userSelect: 'none',
                    background: cell.explicit ? 'color-mix(in oklab, var(--state-running) 12%, transparent)' : 'transparent' }}>
                  <span style={{ ...cond, color: levelColor(cell.level), opacity: cell.explicit ? 1 : 0.5 }}>{cell.level}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────

export default function TeamScreen({ tab }: { tab: Tab }) {
  void tab;
  const [inviting, setInviting] = useState(false);
  const team = useQuery({ queryKey: ['team', 'members'], queryFn: () => api.get<TeamData>('/team/members') });
  const sso = useQuery({ queryKey: ['team', 'sso'], queryFn: () => api.get<SsoView>('/team/sso'), enabled: team.isSuccess });
  const myRole = team.data?.me.role;
  const body = useMemo(() => {
    if (team.isLoading) return <Loading />;
    if (team.error) {
      if (team.error instanceof ApiError && team.error.status === 403) {
        return <Callout kind="info" title="Team & access is for Admins and Owners">Ask an Admin to change your role or connection access.</Callout>;
      }
      return <ErrorBox error={team.error} onRetry={() => team.refetch()} />;
    }
    return null;
  }, [team.isLoading, team.error]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="screen">
      <div style={{ padding: '20px 22px 60px', maxWidth: 1000, display: 'flex', flexDirection: 'column', gap: 26 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 20, lineHeight: '26px', fontWeight: 600 }}>Team &amp; access</div>
            <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--text-secondary)' }}>Workspace membership governs who can see a connection. Database privileges still apply on top.</div>
          </div>
          <span className="spacer" />
          {team.data ? <Button variant="primary" style={{ height: 28 }} onClick={() => setInviting(true)}>+ Invite</Button> : null}
        </div>
        {body}
        {team.data ? (
          <>
            <Members data={team.data} />
            {sso.data ? <SsoPanels sso={sso.data} isOwner={myRole === 'Owner'} /> : sso.error ? <ErrorBox error={sso.error} /> : <Loading />}
            <AccessMatrix data={team.data} />
          </>
        ) : null}
      </div>
      {inviting && myRole ? <InviteModal myRole={myRole} onClose={() => setInviting(false)} /> : null}
    </div>
  );
}
