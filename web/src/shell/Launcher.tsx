import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectionSummary } from '@comb/shared';
import { api } from '../lib/api.ts';
import { useApp, toastError } from '../lib/store.ts';
import { ago } from '../lib/format.ts';
import { Button, EnvBadge, ReadOnlyBadge, IDC, Kbd, Loading, ErrorBox, IconButton } from '../ui/index.tsx';
import { CombMark } from './App.tsx';

export function useConnections() {
  return useQuery({ queryKey: ['connections'], queryFn: () => api.get<ConnectionSummary[]>('/connections') });
}

export async function openConnection(c: ConnectionSummary, setConnecting?: (id: string | null) => void): Promise<void> {
  setConnecting?.(c.id);
  try {
    const fresh = await api.post<ConnectionSummary>(`/connections/${c.id}/open`);
    useApp.getState().openConnection(fresh);
  } catch (e) {
    toastError(e, `Could not open ${c.name}`);
  } finally {
    setConnecting?.(null);
  }
}

export function Launcher() {
  const { data, isLoading, error, refetch } = useConnections();
  const qc = useQueryClient();
  const me = useApp((s) => s.me);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const set = useApp((s) => s.set);
  const [search, setSearch] = useState('');
  const [connecting, setConnecting] = useState<string | null>(null);
  const isAdmin = me?.role === 'Owner' || me?.role === 'Admin';

  const groups = useMemo(() => {
    const q = search.toLowerCase();
    const match = (c: ConnectionSummary) => !q || (c.name + c.host + c.env + c.db).toLowerCase().includes(q);
    const all = (data ?? []).filter(match);
    const recent = all.filter((c) => c.lastOpenedAt && Date.now() - new Date(c.lastOpenedAt).getTime() < 7 * 86400_000).slice(0, 3);
    return [
      ...(recent.length ? [{ label: 'Recent', items: recent }] : []),
      ...(all.length ? [{ label: 'All connections', items: all }] : []),
    ];
  }, [data, search]);

  const loadDemo = async () => {
    try {
      const r = await api.post('/connections/demo');
      await qc.invalidateQueries({ queryKey: ['connections'] });
      const list = await api.get<ConnectionSummary[]>('/connections');
      const c = list.find((x) => x.id === r.id);
      if (c) await openConnection(c, setConnecting);
    } catch (e) {
      toastError(e, 'Could not load the demo database');
    }
  };

  const firstRun = !isLoading && !error && (data?.length ?? 0) === 0;

  return (
    <div style={{ height: '100vh', overflow: 'auto', display: 'flex', justifyContent: 'center', padding: '72px 24px 40px' }}>
      <div style={{ width: '100%', maxWidth: 760 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CombMark />
            <div style={{ fontSize: 20, lineHeight: '26px', fontWeight: 600, letterSpacing: '-0.01em' }}>Comb</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{me?.email}</span>
            <IconButton title="Theme" onClick={toggleTheme} style={{ width: 28, height: 28, border: '1px solid var(--border-subtle)' }}>◐</IconButton>
            <IconButton title="Sign out" onClick={async () => { await api.post('/auth/logout').catch(() => {}); location.reload(); }} style={{ width: 28, height: 28, border: '1px solid var(--border-subtle)' }}>⎋</IconButton>
            <Button variant="primary" disabled={!isAdmin} title={isAdmin ? undefined : 'Only Admins and Owners add connections'} onClick={() => set({ connModal: { mode: 'new' } })}>
              + New connection
            </Button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px', background: 'var(--bg-raised)', border: '1px solid var(--border-subtle)', borderRadius: 3, marginBottom: 26 }}>
          <span style={{ color: 'var(--text-muted)' }}>⌕</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search connections" style={{ flex: 1 }} autoFocus />
          <Kbd>⌘K</Kbd>
        </div>

        {isLoading ? <Loading /> : null}
        {error ? <ErrorBox error={error} onRetry={() => refetch()} /> : null}

        {firstRun ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '20px 0' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 28, lineHeight: '34px', fontWeight: 600, letterSpacing: '-0.01em' }}>No connections yet.</div>
              <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--text-secondary)', maxWidth: 520 }}>
                {isAdmin
                  ? 'Comb needs one Postgres database to be useful. Paste a connection string and it fills in the rest — host, port, database, user.'
                  : 'No connection has been shared with you yet. Ask a workspace Admin for access.'}
              </div>
            </div>
            {isAdmin ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button variant="primary" size="lg" onClick={() => set({ connModal: { mode: 'new' } })}>Add a connection</Button>
                <Button size="lg" onClick={loadDemo}>Load the demo database</Button>
              </div>
            ) : null}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 10, marginTop: 6 }}>
              {[
                ['01', 'Paste a connection string', 'Comb parses it into host, port, database and user, and never echoes the password back.'],
                ['02', 'Tag the environment', 'A prod tag turns on read-only and typed confirmations before anything destructive.'],
                ['03', 'Open a table', 'The grid, the structure and the DDL are one keystroke apart. Nothing is behind a wizard.'],
              ].map(([n, t, b]) => (
                <div key={n} style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: 12, border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-raised)' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-muted)' }}>{n}</span>
                  <span style={{ fontSize: 13, lineHeight: '18px', fontWeight: 500 }}>{t}</span>
                  <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)' }}>{b}</span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)', maxWidth: 520, paddingTop: 6, borderTop: '1px solid var(--border-subtle)' }}>
              Credentials are encrypted at rest on this server and never sent to the browser. A connection tagged <span className="mono">prod</span> opens read-only until you say otherwise.
            </div>
          </div>
        ) : null}

        {groups.map((g) => (
          <div key={g.label} style={{ marginBottom: 26 }}>
            <div className="label" style={{ marginBottom: 8 }}>{g.label}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {g.items.map((c) => (
                <ConnCard key={g.label + c.id} c={c} connecting={connecting === c.id} isAdmin={isAdmin}
                  onOpen={() => openConnection(c, setConnecting)} onEdit={() => set({ connModal: { mode: 'edit', conn: c } })} />
              ))}
            </div>
          </div>
        ))}
        {!firstRun && !isLoading && groups.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <div style={{ fontSize: 24, lineHeight: '30px', fontWeight: 600, marginBottom: 6 }}>No connections match.</div>
            <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)' }}>Try a different name, host, or environment.</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConnCard({ c, connecting, isAdmin, onOpen, onEdit }: { c: ConnectionSummary; connecting: boolean; isAdmin: boolean; onOpen: () => void; onEdit: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className="hov"
      style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-raised)', cursor: 'pointer', overflow: 'hidden' }}
    >
      <div style={{ width: 3, flex: 'none', background: IDC[c.color] ?? IDC.slate }} />
      <div style={{ flex: 1, minWidth: 0, padding: '9px 12px 9px 14px', display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 500 }}>{c.name}</span>
          <EnvBadge env={c.env} />
          {c.readOnly ? <ReadOnlyBadge /> : null}
          {c.requireApproval ? <span className="cond" style={{ color: 'var(--state-running)' }}>APPROVALS</span> : null}
          {c.level === 'read' ? <span className="cond" style={{ color: 'var(--text-muted)' }}>READ ACCESS</span> : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{c.host}:{c.port} · {c.user} · {c.db}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{c.lastOpenedAt ? 'opened ' + ago(c.lastOpenedAt) : 'never opened'}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 10 }}>
        {connecting ? <span className="cond" style={{ color: 'var(--state-running)', animation: 'combpulse 1.6s ease-in-out infinite' }}>CONNECTING…</span> : null}
        {isAdmin ? (
          <button
            title="Edit connection"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="hov hov-text"
            style={{ width: 24, height: 24, borderRadius: 3, color: 'var(--text-muted)', fontSize: 14 }}
          >
            ⋯
          </button>
        ) : null}
      </div>
    </div>
  );
}
