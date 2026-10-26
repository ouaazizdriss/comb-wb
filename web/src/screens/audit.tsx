import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Tab } from '../lib/store.ts';
import { useApp, useConn, toastError } from '../lib/store.ts';
import { api, downloadFrom } from '../lib/api.ts';
import { ms as fmtMs, num } from '../lib/format.ts';
import { Button, ErrorBox, IDC, Loading, MONO, COND } from '../ui/index.tsx';

/*
 * Audit trail (mockup: isAuditTab). Reads /api/audit with keyset pagination; the footer shows
 * the result of verifying the hash chain. The trail is a record: "Open in query tab" and
 * "Draft compensating SQL" only open editors, they never run anything.
 */

interface AuditRow {
  id: number; at: string; actor: string; connection: string | null; color: string | null; env: string | null; kind: string;
  target: string | null; rows: number | null; ms: number | null; status: string; source: string | null; approvalId: number | null;
}
interface AuditPage { rows: AuditRow[]; next: number | null; matched: number; total: number; actors: string[]; ownOnly: boolean; retentionDays: number }
interface AuditDetail extends AuditRow {
  actorName: string | null; auth: string | null; ip: string | null; sql: string | null; hash: string; prevHash: string;
  approval: { id: number; state: string; author: string; decidedBy: string | null; decidedAt: string | null } | null;
  diff: { relation: string; op: string; total: number; captured: number; columns: string[]; masked: boolean; lines: Array<{ sign: '-' | '+'; text: string }> } | null;
  diffNote: string | null; detail: Record<string, any> | null;
}

export const KIND_COLOR: Record<string, string> = {
  SELECT: 'var(--state-info)', EXPLAIN: 'var(--state-info)', EXPORT: 'var(--state-info)', INSERT: 'var(--state-success)', UPDATE: 'var(--state-running)',
  GRANT: 'var(--type-identifier)', REVOKE: 'var(--type-identifier)', ALTER: 'var(--type-identifier)', MIGRATE: 'var(--type-temporal)', CREATE: 'var(--type-temporal)',
  DELETE: 'var(--danger)', TRUNCATE: 'var(--danger)', DROP: 'var(--danger)', TERMINATE: 'var(--danger)', BLOCKED: 'var(--state-running)', ROLLBACK: 'var(--text-muted)',
  APPROVAL: 'var(--type-boolean)', DRYRUN: 'var(--type-boolean)',
};
export const kindColor = (k: string) => KIND_COLOR[k] ?? 'var(--text-secondary)';

const TEMPLATE = '86px 96px 140px 92px minmax(120px,1fr) 64px 72px 100px';
const cell: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
const numCell: React.CSSProperties = { ...cell, justifyContent: 'flex-end', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' };
const labelStyle: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };

function when(iso: string): string {
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, '0');
  const today = new Date().toDateString() === d.toDateString();
  return today ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const short = (email: string) => (email.includes('@') ? email.split('@')[0] : email);
const statusText = (s: string) => (s === 'ok' ? '✓ ok' : s === 'blocked' || s === 'denied' ? '⃠ ' + s : s === 'pending' ? '… pending' : '✕ ' + (s === 'error' ? 'failed' : s));
const statusColor = (s: string) => (s === 'ok' ? 'var(--state-success)' : s === 'blocked' || s === 'denied' || s === 'pending' ? 'var(--state-running)' : 'var(--state-error)');

function FilterGroup<T extends string>({ label, options, value, onChange, labels }: { label: string; options: T[]; value: T; onChange: (v: T) => void; labels?: Record<string, string> }) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden', height: 22, flex: 'none' }}>
      <span style={{ ...labelStyle, display: 'flex', alignItems: 'center', padding: '0 7px', background: 'var(--bg-inset)', borderRight: '1px solid var(--border-subtle)' }}>{label}</span>
      {options.map((o, i) => (
        <button key={o} onClick={() => onChange(o)} title={o}
          style={{ ...labelStyle, padding: '0 7px', whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis',
            background: value === o ? 'var(--bg-selected)' : 'transparent', color: value === o ? 'var(--text-primary)' : 'var(--text-muted)',
            borderRight: i < options.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

export default function AuditScreen({ tab }: { tab: Tab }) {
  const conn = useConn();
  const me = useApp((s) => s.me);
  const updateTab = useApp((s) => s.updateTab);
  const p = tab.params ?? {};
  const [q, setQ] = useState<string>(p.q ?? '');
  const actor: string = p.actor ?? 'All';
  const kind: string = p.kind ?? 'All';
  const windowF: string = p.window ?? '7d';
  const scope: string = p.scope ?? 'All';
  const sel: number | null = p.sel ?? null;
  const setP = (patch: Record<string, unknown>) => updateTab(tab.id, { params: patch });

  const params = new URLSearchParams({ kind, window: windowF, limit: '100' });
  if (q.trim()) params.set('q', q.trim());
  if (actor !== 'All') params.set('actor', actor);
  if (scope === 'This') params.set('connectionId', conn.id);
  const qs = params.toString();

  const list = useInfiniteQuery({
    queryKey: ['audit', qs],
    queryFn: ({ pageParam }) => api.get<AuditPage>(`/audit?${qs}${pageParam ? '&before=' + pageParam : ''}`),
    initialPageParam: 0 as number,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const verify = useQuery({ queryKey: ['audit-verify'], queryFn: () => api.get<{ ok: boolean; text: string }>('/audit/verify'), refetchInterval: 60_000 });

  if (list.isError) return <ErrorBox error={list.error} onRetry={() => list.refetch()} />;
  const first = list.data?.pages[0];
  const rows = list.data?.pages.flatMap((pg) => pg.rows) ?? [];
  const actors = ['All', ...(first?.actors ?? []).slice(0, 5)];
  const isAdmin = me?.role === 'Admin' || me?.role === 'Owner';

  const exportCsv = async () => {
    try {
      const ep = new URLSearchParams(params);
      ep.delete('limit');
      await downloadFrom(`/audit/export.csv?${ep.toString()}`, `comb-audit-${new Date().toISOString().slice(0, 10)}.csv`);
      useApp.getState().toast('Audit export downloaded', `${num(first?.matched ?? 0)} events · CSV · the export itself is in the trail`, 'info');
    } catch (e) {
      toastError(e, 'Export failed');
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflowX: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 3, width: 220, flex: 'none' }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setP({ q })} placeholder="statement, actor, table…" style={{ flex: 1, fontFamily: MONO, fontSize: 12, minWidth: 0 }} />
        </div>
        {!first?.ownOnly ? <FilterGroup label="actor" options={actors} value={actor} onChange={(v) => setP({ actor: v })} labels={Object.fromEntries(actors.map((a) => [a, short(a)]))} /> : null}
        <FilterGroup label="kind" options={['All', 'Writes', 'Reads', 'Schema']} value={kind} onChange={(v) => setP({ kind: v })} />
        <FilterGroup label="window" options={['24h', '7d', '30d', '90d']} value={windowF} onChange={(v) => setP({ window: v })} />
        <FilterGroup label="conn" options={['All', 'This']} value={scope} onChange={(v) => setP({ scope: v })} labels={{ This: conn.name }} />
        <span style={{ flex: 1, minWidth: 8 }} />
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', flex: 'none' }}>
          {first ? `${num(first.matched)} of ${num(first.total)} events${first.ownOnly ? ' · yours' : ''}` : '…'}
        </span>
        {isAdmin ? <Button size="sm" onClick={exportCsv}>⤓ Export CSV</Button> : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: TEMPLATE, minWidth: 820, position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...labelStyle }}>
              {['When', 'Actor', 'Connection', 'Kind', 'Target', 'Rows', 'Time', 'Result'].map((h, i) => (
                <div key={h} style={{ padding: '5px 10px', borderRight: i < 7 ? '1px solid var(--border-subtle)' : 'none', textAlign: i === 5 || i === 6 ? 'right' : 'left' }}>{h}</div>
              ))}
            </div>
            {list.isLoading ? <Loading /> : null}
            {rows.map((a) => (
              <div key={a.id} className="row-hover" onClick={() => setP({ sel: a.id === sel ? null : a.id })}
                style={{ display: 'grid', gridTemplateColumns: TEMPLATE, minWidth: 820, height: 30, borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', background: sel === a.id ? 'var(--bg-selected)' : undefined }}>
                <div style={cell} title={new Date(a.at).toLocaleString()}>{when(a.at)}</div>
                <div style={cell} title={a.actor}>{short(a.actor)}</div>
                <div style={{ ...cell, gap: 6 }}>
                  {a.connection ? <span style={{ width: 2, height: 14, flex: 'none', background: IDC[a.color ?? 'slate'] ?? IDC.slate }} /> : null}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.connection ?? '—'}</span>
                </div>
                <div style={cell}><span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: kindColor(a.kind) }}>{a.kind}</span></div>
                <div style={cell} title={a.target ?? ''}>{a.target ?? '—'}</div>
                <div style={numCell}>{a.rows ? a.rows.toLocaleString('en-US') : '—'}</div>
                <div style={numCell}>{a.ms === null ? '—' : fmtMs(a.ms)}</div>
                <div style={{ ...cell, borderRight: 'none', color: statusColor(a.status) }}>{statusText(a.status)}</div>
              </div>
            ))}
            {!list.isLoading && rows.length === 0 ? (
              <div style={{ padding: '48px 20px', textAlign: 'center' }}>
                <div style={{ fontSize: 24, lineHeight: '30px', fontWeight: 600, marginBottom: 6 }}>Nothing in the trail matches.</div>
                <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)' }}>Widen the window or clear the filters — the trail is append-only, so nothing was deleted.</div>
              </div>
            ) : null}
            {list.hasNextPage ? (
              <div style={{ padding: 10, display: 'flex', justifyContent: 'center' }}>
                <Button size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? 'Loading…' : 'Load older events'}</Button>
              </div>
            ) : null}
          </div>
          <div style={{ height: 26, flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: '0 10px', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', fontSize: 12, color: 'var(--text-muted)' }}>
            <span style={{ fontFamily: MONO, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>retention {first?.retentionDays ?? 400} days · append-only · hash-chained</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: MONO, whiteSpace: 'nowrap', flex: 'none', color: verify.data ? (verify.data.ok ? 'var(--text-muted)' : 'var(--state-error)') : undefined }}>
              {verify.isLoading ? 'verifying chain…' : verify.data?.text ?? 'chain not verified'}
            </span>
          </div>
        </div>
        {sel ? <AuditDetailPanel id={sel} onClose={() => setP({ sel: null })} /> : null}
      </div>
    </div>
  );
}

function AuditDetailPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const openTab = useApp((s) => s.openTab);
  const toast = useApp((s) => s.toast);
  const d = useQuery({ queryKey: ['audit-detail', id], queryFn: () => api.get<AuditDetail>(`/audit/${id}`) });
  const [drafting, setDrafting] = useState(false);
  const [why, setWhy] = useState<string | null>(null);

  const reopen = () => {
    if (!d.data?.sql) return;
    openTab('query', 'untitled', { sql: d.data.sql }, { unique: false });
    toast('Opened in a query tab', 'Not run — the trail is a record, not a shortcut.', 'info');
  };
  const draft = async () => {
    setDrafting(true);
    setWhy(null);
    try {
      const r = await api.get<{ sql: string | null; reason?: string }>(`/audit/${id}/compensate`);
      if (r.sql) {
        openTab('query', 'compensate', { sql: r.sql }, { unique: false });
        toast('Compensating SQL drafted', 'Opened in a new query tab. Review before running; nothing was run.', 'info');
      } else setWhy(r.reason ?? 'Cannot be generated.');
    } catch (e) {
      toastError(e, 'Could not draft compensating SQL');
    } finally {
      setDrafting(false);
    }
  };

  const a = d.data;
  const meta: Array<[string, string]> = a ? [
    ['event', `#${a.id}`],
    ['at', new Date(a.at).toLocaleString()],
    ['actor', a.actorName ? `${a.actorName} · ${a.actor}` : a.actor],
    ...(a.auth ? [['auth', a.auth] as [string, string]] : []),
    ['client ip', a.ip ?? '—'],
    ['connection', a.connection ? `${a.connection}${a.env ? ' (' + a.env + ')' : ''}` : '—'],
    ['kind', a.kind],
    ['target', a.target ?? '—'],
    ['rows', a.rows === null ? '—' : a.rows.toLocaleString('en-US')],
    ['duration', a.ms === null ? '—' : fmtMs(a.ms)],
    ['status', a.status + (a.detail?.reason ? ' · ' + a.detail.reason : a.detail?.message ? ' · ' + a.detail.message : '')],
    ['source', a.source ?? (a.detail?.action ? String(a.detail.action) : '—')],
    ['approval', a.approval ? `ap-${a.approval.id} · ${a.approval.state}${a.approval.decidedBy ? ' by ' + a.approval.decidedBy : ''} · author ${a.approval.author}` : a.approvalId ? `ap-${a.approvalId}` : 'not required'],
    ['hash', a.hash.slice(0, 12) + '…'],
  ] : [];

  return (
    <div style={{ width: 400, flex: 'none', background: 'var(--bg-raised)', borderLeft: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={labelStyle}>Event #{id}</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} className="hov-text" style={{ color: 'var(--text-muted)', fontSize: 12 }} aria-label="Close">✕</button>
      </div>
      {d.isLoading ? <Loading /> : d.isError ? <ErrorBox error={d.error} /> : a ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', padding: '9px 10px' }}>
            <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap', color: a.sql ? undefined : 'var(--text-muted)' }}>{a.sql ?? `-- ${a.kind}${a.target ? ' on ' + a.target : ''} (no statement text)`}</pre>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 12px', alignItems: 'baseline' }}>
            {meta.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <span style={{ ...labelStyle, whiteSpace: 'nowrap' }}>{k}</span>
                <span style={{ fontFamily: MONO, fontSize: 12, lineHeight: '17px', overflowWrap: 'anywhere' }} title={k === 'hash' ? a.hash : undefined}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {a.diff ? (
              <>
                <div style={labelStyle}>Row-level diff · first {Math.min(3, a.diff.captured)} of {a.diff.total.toLocaleString('en-US')}{a.diff.masked ? ' · masked' : ''}</div>
                <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ padding: '3px 10px 3px 26px', fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', background: 'var(--bg-inset)' }}>({a.diff.columns.join(', ')})</div>
                  {a.diff.lines.map((l, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', height: 24, borderTop: '1px solid var(--border-subtle)',
                      background: l.sign === '-' ? 'color-mix(in oklab, var(--danger) 9%, transparent)' : 'color-mix(in oklab, var(--state-success) 9%, transparent)' }}>
                      <span style={{ fontFamily: MONO, fontSize: 12, width: 8, flex: 'none', color: l.sign === '-' ? 'var(--danger)' : 'var(--state-success)' }}>{l.sign}</span>
                      <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.text}>{l.text}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : ['UPDATE', 'DELETE', 'INSERT', 'MERGE', 'TRUNCATE'].includes(a.kind) ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: '17px' }}>{a.diffNote ?? 'No row diff recorded for this event'}</div>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button size="sm" onClick={reopen} disabled={!a.sql}>Open in query tab</Button>
            <Button size="sm" onClick={draft} disabled={drafting} style={{ color: 'var(--state-running)' }}>{drafting ? 'Drafting…' : 'Draft compensating SQL'}</Button>
          </div>
          {why ? <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)', borderLeft: '2px solid var(--state-running)', paddingLeft: 8 }}>{why}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
