import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tab } from '../lib/store.ts';
import { useApp, useConn, toastError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { withConfirm } from '../lib/confirm.ts';
import { Button, ErrorBox, Loading, Modal, MONO, COND, TextInput } from '../ui/index.tsx';

/*
 * Roles & privileges (mockup: isRolesTab). Acts on the target database's real roles.
 * Every change is staged locally, previewed as the exact SQL the server generated, and applied
 * in one transaction through the server's policy-enforcing executor. Passwords are generated
 * server-side and shown once.
 */

interface Role {
  name: string; attrs: string[]; superuser: boolean; login: boolean; createdb: boolean; createrole: boolean; replication: boolean; bypassrls: boolean;
  conns: number; memberOf: string[]; validUntil: string | null; password: string;
}
interface RolesData { connection: string; cluster: string; connUser: string; canAdmin: boolean; readOnly: boolean; requireApproval: boolean; roles: Role[]; allRoles: string[] }
interface PrivData { schema: string; schemas: string[]; privileges: string[]; tables: Array<{ name: string; kind: string; cells: Record<string, string> }> }
interface Session { pid: number; state: string; query: string; app: string; age: string; comb: boolean }

type Change =
  | { type: 'grant'; on: boolean; role: string; schema: string; table: string; privilege: string }
  | { type: 'attr'; on: boolean; role: string; attr: string }
  | { type: 'member'; on: boolean; role: string; group: string }
  | { type: 'validUntil'; role: string; value: string | null };

const ATTRS: Array<[string, keyof Role, string]> = [
  ['LOGIN', 'login', 'can open a session'], ['CREATEDB', 'createdb', 'can create databases'], ['CREATEROLE', 'createrole', 'can create and alter other roles'],
  ['REPLICATION', 'replication', 'can start streaming replication'], ['BYPASSRLS', 'bypassrls', 'ignores every row-level security policy'],
];
const labelStyle: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };

function keyOf(c: Change): string {
  switch (c.type) {
    case 'grant': return `g:${c.role}:${c.schema}:${c.table}:${c.privilege}`;
    case 'attr': return `a:${c.role}:${c.attr}`;
    case 'member': return `m:${c.role}:${c.group}`;
    case 'validUntil': return `v:${c.role}`;
  }
}

function AttrChip({ a }: { a: string }) {
  const danger = a === 'SUPERUSER' || a === 'BYPASSRLS';
  return (
    <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', padding: '0 4px', whiteSpace: 'nowrap', flex: 'none', lineHeight: '16px',
      color: danger ? 'var(--danger)' : a === 'GROUP' || a === 'NOLOGIN' ? 'var(--text-muted)' : 'var(--text-secondary)', border: '1px solid ' + (danger ? 'var(--danger)' : 'var(--border-strong)') }}>
      {a}
    </span>
  );
}

function Track({ on, onClick, danger, disabled, title }: { on: boolean; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button role="switch" aria-checked={on} onClick={onClick} disabled={disabled} title={title}
      style={{ width: 34, height: 18, borderRadius: 9, flex: 'none', background: on ? (danger ? 'var(--danger)' : 'var(--state-success)') : 'var(--border-strong)', display: 'flex', alignItems: 'center',
        padding: 2, justifyContent: on ? 'flex-end' : 'flex-start', opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}>
      <span style={{ width: 14, height: 14, borderRadius: 7, background: 'var(--bg-raised)', display: 'block' }} />
    </button>
  );
}

export default function RolesScreen({ tab }: { tab: Tab }) {
  const conn = useConn();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const updateTab = useApp((s) => s.updateTab);
  const [filter, setFilter] = useState('');
  const [staged, setStaged] = useState<Record<string, Change>>({});
  const [review, setReview] = useState(false);
  const [modal, setModal] = useState<null | 'new' | 'reset' | 'member'>(null);
  const [secret, setSecret] = useState<{ role: string; password: string } | null>(null);

  const data = useQuery({ queryKey: ['roles', conn.id], queryFn: () => api.get<RolesData>(`/roles/${conn.id}`) });
  const roles = data.data?.roles ?? [];
  const selName: string | undefined = tab.params?.role && roles.some((r) => r.name === tab.params!.role) ? tab.params.role : roles.find((r) => r.login && !r.superuser)?.name ?? roles[0]?.name;
  const R = roles.find((r) => r.name === selName);
  const schema: string = tab.params?.schema ?? 'public';
  const select = (patch: Record<string, unknown>) => updateTab(tab.id, { params: patch });

  const privs = useQuery({
    queryKey: ['role-privs', conn.id, selName, schema],
    queryFn: () => api.get<PrivData>(`/roles/${conn.id}/privileges?role=${encodeURIComponent(selName!)}&schema=${encodeURIComponent(schema)}`),
    enabled: !!selName,
  });
  const sessions = useQuery({
    queryKey: ['role-sessions', conn.id, selName],
    queryFn: () => api.get<Session[]>(`/roles/${conn.id}/sessions?role=${encodeURIComponent(selName!)}`),
    enabled: !!selName, refetchInterval: 15_000,
  });

  const changes = Object.values(staged);
  const preview = useQuery({
    queryKey: ['roles-preview', conn.id, JSON.stringify(changes)],
    queryFn: () => api.post<{ sql: string; runAs: string }>(`/roles/${conn.id}/preview`, { changes }),
    enabled: review && changes.length > 0,
  });
  useEffect(() => { if (!changes.length) setReview(false); }, [changes.length]);

  const stage = (c: Change, base: boolean | string | null) => {
    const k = keyOf(c);
    setStaged((s) => {
      const next = { ...s };
      const val = c.type === 'validUntil' ? c.value : c.on;
      if (val === base) delete next[k];
      else next[k] = c;
      return next;
    });
  };

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['roles', conn.id] });
    qc.invalidateQueries({ queryKey: ['role-privs', conn.id] });
    qc.invalidateQueries({ queryKey: ['role-sessions', conn.id] });
  };

  const apply = async () => {
    try {
      const r = await withConfirm((confirm) => api.post<any>(`/roles/${conn.id}/apply`, { changes, confirm }), { title: `Apply ${changes.length} privilege change${changes.length === 1 ? '' : 's'}` });
      if (!r) return;
      setStaged({});
      setReview(false);
      if (r.approvalId) toast(`Sent for approval · ap-${r.approvalId}`, `${conn.name} requires a second person for writes. Nothing ran yet.`, 'info');
      else toast(`Applied ${changes.length} change${changes.length === 1 ? '' : 's'}`, `COMMIT · ${r.ms} ms`, 'success');
      refresh();
    } catch (e) {
      toastError(e, 'Changes were not applied');
    }
  };

  const dropRole = async () => {
    if (!R) return;
    try {
      const r = await withConfirm((confirm) => api.post<any>(`/roles/${conn.id}/drop`, { role: R.name, confirm }), {
        title: `DROP ROLE ${R.name}`, body: 'The role is removed from the cluster. Objects it owns or privileges granted to it must be reassigned or revoked first, or Postgres refuses.',
      });
      if (!r) return;
      if (r.approvalId) toast(`Sent for approval · ap-${r.approvalId}`, 'DROP ROLE waits for a second person.', 'info');
      else toast(`Dropped role ${R.name}`, 'Recorded in the audit trail.', 'success');
      select({ role: null });
      refresh();
    } catch (e) {
      toastError(e, 'Role was not dropped');
    }
  };

  const terminate = async (s: Session) => {
    if (!R) return;
    try {
      await api.post(`/roles/${conn.id}/terminate`, { pid: s.pid, role: R.name });
      toast(`pg_terminate_backend(${s.pid})`, 'Backend terminated. Recorded as TERMINATE in the audit trail.', 'error');
      sessions.refetch();
    } catch (e) {
      toastError(e, `pid ${s.pid} was not terminated`);
    }
  };

  const shown = useMemo(() => roles.filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase())), [roles, filter]);
  if (data.isLoading) return <Loading />;
  if (data.isError) return <ErrorBox error={data.error} onRetry={() => data.refetch()} />;
  const D = data.data!;
  const canAdmin = D.canAdmin;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflowX: 'auto' }}>
        <span style={{ ...labelStyle, whiteSpace: 'nowrap', flex: 'none' }}>Roles &amp; privileges</span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none' }}>{roles.length} roles · cluster {D.cluster}</span>
        {!canAdmin ? <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{D.readOnly ? 'read-only connection · view only' : 'view only · changes need admin access'}</span> : null}
        <span style={{ flex: 1, minWidth: 8 }} />
        {canAdmin ? <Button size="sm" onClick={() => setModal('new')}>+ New role</Button> : null}
        {changes.length ? (
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--state-running)', whiteSpace: 'nowrap', flex: 'none' }}>⚠ {changes.length} pending</span>
            <Button size="sm" variant="primary" onClick={() => setReview((v) => !v)}>Review</Button>
            <Button size="sm" variant="ghost" onClick={() => { setStaged({}); setReview(false); }}>Discard</Button>
          </>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ width: 250, flex: 'none', borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', background: 'var(--bg-raised)' }}>
          <div style={{ padding: 8, flex: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 8px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 3 }}>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter roles" style={{ flex: 1, fontFamily: MONO, fontSize: 12, minWidth: 0 }} />
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {shown.map((r) => (
              <div key={r.name} className="row-hover" onClick={() => select({ role: r.name })}
                style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '7px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)', background: selName === r.name ? 'var(--bg-selected)' : undefined }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', flex: 'none', background: r.conns ? 'var(--state-success)' : 'var(--border-strong)' }} />
                  <span style={{ fontFamily: MONO, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.conns ? `${r.conns} conn` : ''}</span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{r.attrs.map((a) => <AttrChip key={a} a={a} />)}</div>
              </div>
            ))}
            {!shown.length ? <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>No role matches.</div> : null}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {R ? (
            <div style={{ padding: '16px 18px 40px', display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 860 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: MONO, fontSize: 20, lineHeight: '26px', fontWeight: 500 }}>{R.name}</span>
                {R.attrs.map((a) => <AttrChip key={a} a={a} />)}
                <span style={{ flex: 1 }} />
                {canAdmin ? <Button variant="danger-ghost" size="sm" onClick={dropRole}>Drop role…</Button> : null}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={labelStyle}>Attributes</div>
                  {ATTRS.map(([attr, field, hint]) => {
                    const base = !!R[field];
                    const k = `a:${R.name}:${attr}`;
                    const on = staged[k] ? (staged[k] as { on: boolean }).on : base;
                    return (
                      <div key={attr} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <span style={{ fontFamily: MONO, fontSize: 13, color: staged[k] ? 'var(--state-running)' : undefined }}>{attr}{staged[k] ? ' · staged' : ''}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</span>
                        </div>
                        <Track on={on} danger={attr === 'BYPASSRLS'} disabled={!canAdmin} title={canAdmin ? undefined : 'Needs admin access on this connection'}
                          onClick={() => stage({ type: 'attr', role: R.name, attr, on: !on }, base)} />
                      </div>
                    );
                  })}
                  {R.superuser ? <div style={{ fontSize: 11, color: 'var(--danger)', lineHeight: '15px' }}>SUPERUSER bypasses every check above. Comb shows it but does not toggle it.</div> : null}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={labelStyle}>Identity</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Password</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <span style={{ flex: 1, height: 26, display: 'flex', alignItems: 'center', padding: '0 9px', background: 'var(--bg-raised)', border: '1px solid var(--border-strong)', borderRadius: 3, fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', whiteSpace: 'nowrap' }}>{R.password}</span>
                      {canAdmin ? <Button onClick={() => setModal('reset')}>Reset…</Button> : null}
                    </div>
                  </div>
                  <ValidUntil role={R} staged={staged} canAdmin={canAdmin} onStage={(v) => stage({ type: 'validUntil', role: R.name, value: v }, R.validUntil ? R.validUntil.slice(0, 10) : null)} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Member of</span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {[...new Set([...R.memberOf, ...changes.filter((c) => c.type === 'member' && c.role === R.name && c.on).map((c) => (c as { group: string }).group)])].map((g) => {
                        const k = `m:${R.name}:${g}`;
                        const st = staged[k] as { on: boolean } | undefined;
                        const removed = st && !st.on;
                        return (
                          <span key={g} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px', border: '1px solid ' + (st ? 'var(--state-running)' : 'var(--border-subtle)'), borderRadius: 3, fontFamily: MONO, fontSize: 12,
                            textDecoration: removed ? 'line-through' : undefined, color: st ? 'var(--state-running)' : undefined }}>
                            {g}
                            {canAdmin ? (
                              <button className="hov-text" title={removed ? 'Undo' : `Stage revoke ${g} from ${R.name}`} style={{ color: 'var(--text-muted)', fontSize: 11 }}
                                onClick={() => stage({ type: 'member', role: R.name, group: g, on: !!removed }, R.memberOf.includes(g))}>{removed ? '↺' : '✕'}</button>
                            ) : null}
                          </span>
                        );
                      })}
                      {!R.memberOf.length && !changes.some((c) => c.type === 'member' && c.role === R.name) ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>no group roles</span> : null}
                      {canAdmin ? (
                        <button onClick={() => setModal('member')} className="hov-text" style={{ height: 22, padding: '0 8px', border: '1px dashed var(--border-strong)', borderRadius: 3, fontSize: 12, color: 'var(--text-secondary)' }}>+ grant membership</button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={labelStyle}>Table privileges · schema</span>
                  <select value={schema} onChange={(e) => select({ schema: e.target.value })}
                    style={{ height: 22, fontFamily: MONO, fontSize: 12, background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', borderRadius: 3, padding: '0 4px' }}>
                    {(privs.data?.schemas ?? [schema]).map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{canAdmin ? 'click a cell to stage a GRANT or REVOKE' : '● direct grant · ○ inherited'}</span>
                </div>
                <PrivGrid data={privs.data} loading={privs.isLoading} error={privs.error} role={R.name} staged={staged} canAdmin={canAdmin} onStage={stage} />
              </div>

              {review && changes.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={labelStyle}>Statements to run</div>
                  <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', padding: '10px 12px' }}>
                    {preview.isError ? <span style={{ color: 'var(--state-error)', fontSize: 12 }}>{(preview.error as Error).message}</span> : (
                      <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: '19px', whiteSpace: 'pre-wrap' }}>{preview.data?.sql ?? 'generating…'}</pre>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      Runs inside <span style={{ fontFamily: MONO }}>BEGIN … COMMIT</span> as <span style={{ fontFamily: MONO }}>{preview.data?.runAs ?? D.connUser}</span>.
                      {D.requireApproval ? ' This connection requires approval, so it is queued for a second person.' : ''}
                    </span>
                    <span style={{ flex: 1 }} />
                    <Button onClick={() => setReview(false)}>Close</Button>
                    <Button variant="primary" onClick={apply} disabled={!canAdmin || !preview.data}>Apply</Button>
                  </div>
                </div>
              ) : null}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={labelStyle}>Active sessions · pg_stat_activity</div>
                {sessions.data?.length ? (
                  <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
                    {sessions.data.map((s, i) => (
                      <div key={s.pid} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 30, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
                        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)', width: 56, flex: 'none' }}>{s.pid}</span>
                        <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', width: 118, flex: 'none',
                          color: s.state === 'active' ? 'var(--state-success)' : s.state === 'idle' ? 'var(--text-muted)' : 'var(--state-running)' }}>{s.state || '—'}</span>
                        <span style={{ fontFamily: MONO, fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }} title={s.query}>{s.query.replace(/\s+/g, ' ').trim() || '—'}</span>
                        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{s.age}</span>
                        {s.comb ? (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title="Comb's own connection; use Cancel on the query instead">comb</span>
                        ) : canAdmin ? (
                          <button onClick={() => terminate(s)} className="hov" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>terminate</button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: 20, border: '1px solid var(--border-subtle)', borderRadius: 3, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    {sessions.isLoading ? 'Loading…' : <>No open backends for <span style={{ fontFamily: MONO }}>{R.name}</span>.</>}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ padding: 40, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>No roles visible on this connection.</div>
          )}
        </div>
      </div>

      {modal === 'new' ? <NewRoleModal connId={conn.id} onClose={() => setModal(null)} onCreated={(name, password) => { setModal(null); refresh(); select({ role: name }); if (password) setSecret({ role: name, password }); }} /> : null}
      {modal === 'reset' && R ? <ResetModal connId={conn.id} role={R.name} onClose={() => setModal(null)} onDone={(password) => { setModal(null); setSecret({ role: R.name, password }); refresh(); }} /> : null}
      {modal === 'member' && R ? (
        <MemberModal role={R} all={D.allRoles} onClose={() => setModal(null)} onPick={(g) => { stage({ type: 'member', role: R.name, group: g, on: true }, R.memberOf.includes(g)); setModal(null); }} />
      ) : null}
      {secret ? <SecretModal role={secret.role} password={secret.password} onClose={() => setSecret(null)} /> : null}
    </div>
  );
}

function ValidUntil({ role, staged, canAdmin, onStage }: { role: Role; staged: Record<string, Change>; canAdmin: boolean; onStage: (v: string | null) => void }) {
  const st = staged[`v:${role.name}`] as { value: string | null } | undefined;
  const value = st ? st.value : role.validUntil ? role.validUntil.slice(0, 10) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Valid until{st ? <span style={{ color: 'var(--state-running)' }}> · staged</span> : null}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="date" value={value ?? ''} disabled={!canAdmin} onChange={(e) => onStage(e.target.value || null)}
          style={{ flex: 1, height: 26, padding: '0 9px', background: 'var(--bg-raised)', border: '1px solid ' + (st ? 'var(--state-running)' : 'var(--border-strong)'), borderRadius: 3, fontFamily: MONO, fontSize: 12, color: 'var(--text-primary)', colorScheme: 'inherit' }} />
        {value && canAdmin ? <Button onClick={() => onStage(null)} title="No expiry">∞</Button> : null}
      </div>
      {!value ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>— no expiry</span> : null}
    </div>
  );
}

function PrivGrid({ data, loading, error, role, staged, canAdmin, onStage }: {
  data?: PrivData; loading: boolean; error: unknown; role: string; staged: Record<string, Change>; canAdmin: boolean; onStage: (c: Change, base: boolean) => void;
}) {
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const T = `minmax(170px, 1.4fr) repeat(${data.privileges.length}, 1fr)`;
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'auto', maxHeight: 420 }}>
      <div style={{ display: 'grid', gridTemplateColumns: T, minWidth: 620, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...labelStyle, position: 'sticky', top: 0, zIndex: 1 }}>
        <div style={{ padding: '5px 10px', borderRight: '1px solid var(--border-subtle)' }}>Table</div>
        {data.privileges.map((p) => <div key={p} style={{ padding: '5px 6px', textAlign: 'center', borderRight: '1px solid var(--border-subtle)' }}>{p}</div>)}
      </div>
      {data.tables.map((t, i) => (
        <div key={t.name} className="row-hover" style={{ display: 'grid', gridTemplateColumns: T, minWidth: 620, height: 28, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }} title={t.name}>
            {t.name}{t.kind === 'v' || t.kind === 'm' ? <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>view</span> : null}
          </div>
          {data.privileges.map((p) => {
            const state = t.cells[p] ?? 'none';
            const base = state === 'direct';
            const k = `g:${role}:${data.schema}:${t.name}:${p}`;
            const st = staged[k] as { on: boolean } | undefined;
            const on = st ? st.on : base;
            const fixed = state === 'owner' || state === 'superuser';
            const mark = on ? '●' : state === 'inherited' || fixed ? '○' : '·';
            const title = fixed ? `${role} is ${state === 'owner' ? 'the owner' : 'a superuser'}: always allowed` : state === 'inherited' && !on ? 'Inherited through a group role; granting adds a direct grant' : `${on ? 'Revoke' : 'Grant'} ${p} on ${t.name}`;
            return (
              <div key={p} title={title} onClick={canAdmin && !fixed ? () => onStage({ type: 'grant', role, schema: data.schema, table: t.name, privilege: p, on: !on }, base) : undefined}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: '1px solid var(--border-subtle)', cursor: canAdmin && !fixed ? 'pointer' : 'default',
                  background: st ? 'color-mix(in oklab, var(--state-running) 14%, transparent)' : 'transparent' }}>
                <span style={{ fontSize: on || mark === '○' ? 9 : 12, color: st ? 'var(--state-running)' : on ? 'var(--state-success)' : mark === '○' ? 'var(--text-secondary)' : 'var(--text-muted)' }}>{mark}</span>
              </div>
            );
          })}
        </div>
      ))}
      {!data.tables.length ? <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>No tables in {data.schema}.</div> : null}
    </div>
  );
}

function NewRoleModal({ connId, onClose, onCreated }: { connId: string; onClose: () => void; onCreated: (name: string, password: string | null) => void }) {
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState('');
  const [login, setLogin] = useState(true);
  const [pw, setPw] = useState(true);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await withConfirm((confirm) => api.post<any>(`/roles/${connId}/create`, { name: name.trim(), login, password: pw, confirm }));
      if (!r) return;
      if (r.approvalId) {
        toast(`Sent for approval · ap-${r.approvalId}`, 'CREATE ROLE waits for a second person.', 'info');
        onClose();
      } else onCreated(name.trim(), r.password ?? null);
    } catch (e) {
      toastError(e, 'Role was not created');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New role" onClose={onClose} width={440} footer={<><span className="spacer" /><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>Create role</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Name</span>
          <TextInput mono value={name} onChange={(e) => setName(e.target.value)} placeholder="readonly_bi" onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}><input type="checkbox" checked={login} onChange={(e) => setLogin(e.target.checked)} /> LOGIN — can open a session</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}><input type="checkbox" checked={pw} onChange={(e) => setPw(e.target.checked)} /> Generate a password</label>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: '17px' }}>
          The password is generated on the server, sent to Postgres as a SCRAM verifier, shown to you once and never stored or logged. The audit trail records <span style={{ fontFamily: MONO }}>password '***'</span>.
        </span>
      </div>
    </Modal>
  );
}

function ResetModal({ connId, role, onClose, onDone }: { connId: string; role: string; onClose: () => void; onDone: (password: string) => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await withConfirm((confirm) => api.post<{ password: string }>(`/roles/${connId}/password`, { role, confirm }));
      if (r) onDone(r.password);
    } catch (e) {
      toastError(e, 'Password was not reset');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Reset password for ${role}`} onClose={onClose} width={440} footer={<><span className="spacer" /><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} disabled={busy}>Generate new password</Button></>}>
      <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--text-secondary)' }}>
        Comb generates a strong random password, applies <span style={{ fontFamily: MONO }}>alter role {role} with password '…'</span> immediately and shows it once. Existing sessions stay open; new logins need the new password. Never logged, never in history.
      </div>
    </Modal>
  );
}

function SecretModal({ role, password, onClose }: { role: string; password: string; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast('Copied to clipboard', 'Paste it into your secret manager now.', 'info');
    } catch {
      toast('Copy failed', 'Select the text and copy it manually.', 'error');
    }
  };
  return (
    <Modal title={`New password for ${role}`} onClose={onClose} width={460} footer={<><span className="spacer" /><Button onClick={copy}>Copy</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontFamily: MONO, fontSize: 15, padding: '10px 12px', border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', userSelect: 'all', wordBreak: 'break-all' }}>{password}</div>
        <span style={{ fontSize: 12, color: 'var(--state-running)' }}>⚠ Shown once. Comb does not store it; closing this dialog discards it.</span>
      </div>
    </Modal>
  );
}

function MemberModal({ role, all, onClose, onPick }: { role: Role; all: string[]; onClose: () => void; onPick: (g: string) => void }) {
  const [f, setF] = useState('');
  const options = all.filter((g) => g !== role.name && !role.memberOf.includes(g) && g.toLowerCase().includes(f.toLowerCase()));
  return (
    <Modal title={`Grant membership to ${role.name}`} onClose={onClose} width={420}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <TextInput mono value={f} onChange={(e) => setF(e.target.value)} placeholder="filter roles" />
        <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 3 }}>
          {options.map((g) => (
            <div key={g} className="row-hover" onClick={() => onPick(g)} style={{ padding: '6px 10px', fontFamily: MONO, fontSize: 12, cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)' }}>{g}</div>
          ))}
          {!options.length ? <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>No other role matches.</div> : null}
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Stages <span style={{ fontFamily: MONO }}>grant &lt;group&gt; to {role.name}</span>; nothing runs until you Review and Apply.</span>
      </div>
    </Modal>
  );
}
