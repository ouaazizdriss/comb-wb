import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  HealthResponse, LockRow, MonitorAlert, MonitorBucket, MonitorOverview, MonitorRange, SlowStatementsResponse,
} from '@comb/shared/src/ops.ts';
import type { Tab } from '../lib/store.ts';
import { useApp, useConn, toastError } from '../lib/store.ts';
import { api, ApiError } from '../lib/api.ts';
import { ago, bytes, num } from '../lib/format.ts';
import { Button, Callout, COND, Dot, ErrorBox, Label, Loading, MONO, Seg } from '../ui/index.tsx';

/*
 * Monitoring (mockup isMonitorTab). KPI tiles over the sampler's history plus a live snapshot,
 * open alerts, slowest statements, blocking tree and table health, all for the open connection.
 */

const RANGES: readonly MonitorRange[] = ['15m', '1h', '6h', '24h'];
const SLOW_SORTS = ['Total time', 'Mean', 'Calls'] as const;
type SlowSort = (typeof SLOW_SORTS)[number];
const SORT_KEY: Record<SlowSort, string> = { 'Total time': 'total', Mean: 'mean', Calls: 'calls' };
const LIVE_MS = 10_000;

type Tone = 'ok' | 'warn' | 'err';
const toneColor = (t: Tone) => (t === 'err' ? 'var(--state-error)' : t === 'warn' ? 'var(--state-running)' : 'var(--text-primary)');

const condLabel: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };

function secs(s: number | null | undefined): { v: string; u: string } {
  if (s === null || s === undefined) return { v: '—', u: '' };
  if (s < 60) return { v: s < 10 ? s.toFixed(1) : String(Math.round(s)), u: 's' };
  if (s < 3600) return { v: (s / 60).toFixed(s < 600 ? 1 : 0), u: 'min' };
  if (s < 86400 * 2) return { v: (s / 3600).toFixed(1), u: 'h' };
  return { v: String(Math.round(s / 86400)), u: 'd' };
}

function uptime(iso: string | null): string {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

function clock(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function waitFmt(s: number | null): string {
  if (s === null) return '';
  const t = Math.max(0, Math.round(s));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
}

function durMs(v: number): string {
  if (v < 1) return v.toFixed(2) + ' ms';
  if (v < 1000) return Math.round(v) + ' ms';
  if (v < 60_000) return (v / 1000).toFixed(1) + ' s';
  if (v < 3_600_000) return (v / 60_000).toFixed(1) + ' min';
  return (v / 3_600_000).toFixed(1) + ' h';
}

/** Normalises a series to 0..1 for the sparkline; null buckets stay null. */
function norm(vals: Array<number | null>, ceiling?: number): Array<number | null> {
  const max = ceiling ?? Math.max(0, ...vals.filter((v): v is number => v !== null));
  return vals.map((v) => (v === null ? null : max > 0 ? Math.max(0.08, Math.min(1, v / max)) : 0.08));
}

interface Kpi { label: string; value: string; unit: string; note: string; tone: Tone; bars: Array<number | null> }

function buildKpis(o: MonitorOverview): Kpi[] {
  const L = o.live;
  const b = o.buckets;
  const pick = (f: (x: MonitorBucket) => number | null) => b.map(f);
  const r = o.rules;
  const kpis: Kpi[] = [];

  const pct = L && L.maxConn ? (L.connTotal / L.maxConn) * 100 : 0;
  kpis.push({
    label: 'Connections', value: L ? String(L.connTotal) : '—', unit: L ? '/ ' + L.maxConn : '',
    note: o.totals.peakConn !== null ? `peak ${o.totals.peakConn} at ${clock(o.totals.peakConnAt)} · ${L?.connActive ?? 0} active` : `${L?.connActive ?? 0} active · ${L?.connIdleTxn ?? 0} idle in txn`,
    tone: pct > 95 ? 'err' : pct > r.connectionsPct ? 'warn' : 'ok', bars: norm(pick((x) => x.connTotal)),
  });

  const tps = L?.tps ?? null;
  const tv = tps === null ? { v: '—', u: '' } : tps >= 1000 ? { v: (tps / 1000).toFixed(1), u: 'k/s' } : { v: tps < 10 ? tps.toFixed(1) : String(Math.round(tps)), u: '/s' };
  const avg = o.totals.avgTps;
  const prev = o.totals.prevAvgTps;
  kpis.push({
    label: 'Transactions', value: tv.v, unit: tv.u,
    note: avg !== null && prev ? `${avg >= prev ? '+' : ''}${Math.round(((avg - prev) / prev) * 100)}% vs previous ${o.range}` : tps === null ? 'needs two samples' : `avg ${avg !== null ? avg.toFixed(1) : '—'}/s over ${o.range}`,
    tone: 'ok', bars: norm(pick((x) => x.tps)),
  });

  const ch = L?.cacheHit ?? null;
  kpis.push({
    label: 'Cache hit', value: ch === null ? '—' : (ch * 100).toFixed(1), unit: ch === null ? '' : '%', note: `shared_buffers ${L?.sharedBuffers ?? '—'}`,
    tone: ch !== null && ch * 100 < r.cacheHitPct ? 'warn' : 'ok', bars: norm(pick((x) => (x.cacheHit === null ? null : x.cacheHit)), 1),
  });

  const lag = L?.replLag ?? null;
  const lv = secs(lag);
  kpis.push({
    label: 'Replica lag', value: lv.v, unit: lv.u,
    note: !L ? '—' : L.isReplica ? `this is a replica · threshold ${r.replicaLagSeconds} s` : L.replicas ? `${L.replicas} replica${L.replicas > 1 ? 's' : ''} · threshold ${r.replicaLagSeconds} s` : 'no replicas streaming',
    tone: lag !== null && lag > r.replicaLagSeconds ? 'warn' : 'ok', bars: norm(pick((x) => x.replLag)),
  });

  const lx = L?.longestXactS ?? null;
  const xv = secs(lx);
  const idleBad = (L?.longestIdleTxnS ?? 0) > r.idleTxnSeconds;
  kpis.push({
    label: 'Longest transaction', value: xv.v, unit: xv.u,
    note: lx === null ? 'no open transactions' : `pid ${L?.longestXactPid} · ${L?.longestXactState ?? 'unknown'}`,
    tone: lx !== null && lx > r.longXactSeconds * 4 ? 'err' : (lx !== null && lx > r.longXactSeconds) || idleBad ? 'warn' : 'ok', bars: norm(pick((x) => x.longestXact)),
  });

  kpis.push({
    label: 'Deadlocks', value: String(o.totals.deadlocks), unit: 'in ' + o.range,
    note: L ? `${num(L.deadlocksTotal)} since stats reset` : '—', tone: o.totals.deadlocks > 0 ? 'err' : 'ok', bars: norm(pick((x) => x.deadlocks)),
  });
  return kpis;
}

function KpiTile({ k }: { k: Kpi }) {
  const edge = k.tone === 'err' ? 'var(--state-error)' : k.tone === 'warn' ? 'var(--state-running)' : 'var(--border-strong)';
  const fill = k.tone === 'err' ? 'color-mix(in oklab, var(--state-error) 55%, transparent)' : k.tone === 'warn' ? 'color-mix(in oklab, var(--state-running) 55%, transparent)' : 'var(--border-strong)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 11px', border: '1px solid var(--border-subtle)', borderLeft: '3px solid ' + edge, borderRadius: 3, background: 'var(--bg-raised)', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span style={{ fontFamily: MONO, fontSize: 24, lineHeight: '30px', fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: toneColor(k.tone) }}>{k.value}</span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)' }}>{k.unit}</span>
      </div>
      <div style={condLabel}>{k.label}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 22 }} aria-hidden>
        {k.bars.map((v, i) => (
          <span key={i} style={{ flex: 1, height: v === null ? 1 : Math.max(2, Math.round(v * 22)), background: v === null ? 'var(--border-subtle)' : fill }} />
        ))}
      </div>
      <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.note}</div>
    </div>
  );
}

function AlertRow({ a, canAck, onAck }: { a: MonitorAlert; canAck: boolean; onAck: () => void }) {
  const crit = a.severity === 'crit';
  const c = crit ? 'var(--state-error)' : 'var(--state-running)';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 11px', border: '1px solid var(--border-subtle)', borderLeft: '3px solid ' + c, borderRadius: 3, background: 'var(--bg-raised)' }}>
      <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', width: 66, flex: 'none', color: c, lineHeight: '18px' }}>{crit ? 'CRITICAL' : 'WARNING'}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, lineHeight: '18px' }}>{a.title}</span>
        <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)' }}>{a.body}</span>
      </div>
      <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', lineHeight: '18px' }}>{ago(a.openedAt).replace(' ago', '')}</span>
      {canAck ? <Button size="sm" onClick={onAck}>Ack</Button> : null}
    </div>
  );
}

function SlowTable({ data, onExplain }: { data: SlowStatementsResponse; onExplain: (sql: string) => void }) {
  if (!data.available) {
    return <Callout kind="info" title={data.reason}><span style={{ fontFamily: MONO }}>{data.hint}</span></Callout>;
  }
  const T = 'minmax(280px,1fr) 92px 88px 96px 190px';
  const cell: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' };
  const maxShare = Math.max(0.0001, ...data.rows.map((r) => r.share));
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: T, minWidth: 760, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...condLabel }}>
        <div style={{ padding: '5px 10px', borderRight: '1px solid var(--border-subtle)' }}>Normalised statement</div>
        <div style={{ padding: '5px 10px', borderRight: '1px solid var(--border-subtle)', textAlign: 'right' }}>Calls</div>
        <div style={{ padding: '5px 10px', borderRight: '1px solid var(--border-subtle)', textAlign: 'right' }}>Mean</div>
        <div style={{ padding: '5px 10px', borderRight: '1px solid var(--border-subtle)', textAlign: 'right' }}>Total</div>
        <div style={{ padding: '5px 10px' }}>Share</div>
      </div>
      {data.rows.length === 0 ? <div style={{ padding: '18px 12px', fontSize: 12, color: 'var(--text-muted)' }}>No statements recorded yet in this database.</div> : null}
      {data.rows.map((s, i) => (
        <div key={s.queryid + i} className="row-hover" style={{ display: 'grid', gridTemplateColumns: T, minWidth: 760, height: 32, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
          <div title={s.query} style={{ display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, minWidth: 0 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.query.replace(/\s+/g, ' ')}</span>
          </div>
          <div style={cell}>{num(s.calls)}</div>
          <div style={{ ...cell, color: s.meanMs >= 1000 ? 'var(--state-running)' : 'var(--text-secondary)' }}>{durMs(s.meanMs)}</div>
          <div style={cell}>{durMs(s.totalMs)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px' }}>
            <span style={{ width: Math.max(2, Math.round((s.share / maxShare) * 70)), height: 6, background: 'var(--state-info)', borderRadius: 3, flex: 'none' }} />
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', width: 34 }}>{Math.round(s.share * 100)}%</span>
            <span className="spacer" />
            <button onClick={() => onExplain(s.query)} style={{ fontSize: 11, color: 'var(--state-info)', whiteSpace: 'nowrap' }}>explain</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function LockTree({ rows, canKill, onKill }: { rows: LockRow[]; canKill: boolean; onKill: (r: LockRow) => void }) {
  if (!rows.length) {
    return <div style={{ padding: '14px 12px', fontSize: 12, color: 'var(--text-muted)' }}>No blocking right now. Sessions waiting on locks show up here with whoever holds them.</div>;
  }
  return (
    <>
      {rows.map((l, i) => {
        const blocker = l.blocks > 0;
        const tag = blocker ? `blocks ${l.blocks}` : 'waits';
        return (
          <div key={l.pid} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', paddingLeft: 10 + l.depth * 16, height: 30, borderTop: i ? '1px solid var(--border-subtle)' : 'none',
            background: blocker && l.depth === 0 ? 'color-mix(in oklab, var(--state-error) 8%, transparent)' : 'transparent' }}>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)', width: 52, flex: 'none' }}>{l.pid}</span>
            <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', width: 62, flex: 'none',
              color: blocker ? 'var(--state-error)' : 'var(--state-running)' }}>{tag}</span>
            <span title={`${l.user ?? ''} · ${l.app ?? ''} · ${l.state ?? ''}\n${l.query}`} style={{ fontFamily: MONO, fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
              {l.depth === 0 && l.state ? <span style={{ color: 'var(--text-muted)' }}>{l.state} · </span> : null}
              {l.lock && l.depth > 0 ? <span style={{ color: 'var(--text-muted)' }}>{l.lock} · </span> : null}
              {l.query.replace(/\s+/g, ' ')}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{waitFmt(l.waitS)}</span>
            {l.internal ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title="Comb's own session">comb</span>
              : canKill ? <button onClick={() => onKill(l)} onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--danger)'; }} onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>terminate</button> : null}
          </div>
        );
      })}
    </>
  );
}

function HealthList({ data }: { data: HealthResponse }) {
  if (!data.rows.length) return <div style={{ padding: '14px 12px', fontSize: 12, color: 'var(--text-muted)' }}>No user tables in this database.</div>;
  return (
    <>
      {data.rows.map((h, i) => {
        const p = h.bloat === null ? null : Math.round(h.bloat * 100);
        const c = p === null ? 'var(--text-muted)' : p >= 50 ? 'var(--state-error)' : p >= 30 ? 'var(--state-running)' : 'var(--state-success)';
        const vac = [h.lastVacuum, h.lastAutovacuum].filter(Boolean).sort().pop() ?? null;
        return (
          <div key={h.schema + '.' + h.name} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', height: 28, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}
            title={`${h.schema}.${h.name} · ${num(h.liveTup)} live / ${num(h.deadTup)} dead tuples · estimate: ${h.method ?? 'none'}`}>
            <span style={{ fontFamily: MONO, fontSize: 12, width: 132, flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.schema === 'public' ? h.name : `${h.schema}.${h.name}`}</span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', width: 62, flex: 'none', textAlign: 'right' }}>{bytes(h.totalBytes)}</span>
            <div style={{ flex: 1, minWidth: 60, height: 6, background: 'var(--bg-inset)', borderRadius: 3, overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: (p ?? 0) + '%', background: c }} />
            </div>
            <span style={{ fontFamily: MONO, fontSize: 11, width: 36, flex: 'none', textAlign: 'right', color: p !== null && p >= 30 ? c : 'var(--text-secondary)' }}>{p === null ? '—' : p + '%'}</span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', width: 74, textAlign: 'right' }}>{vac ? ago(vac) : 'never'}</span>
          </div>
        );
      })}
    </>
  );
}

/** Monitoring. */
export default function MonitorScreen({ tab }: { tab: Tab }) {
  const conn = useConn();
  const me = useApp((s) => s.me);
  const qc = useQueryClient();
  const range: MonitorRange = (tab.params?.range as MonitorRange) ?? '1h';
  const [live, setLive] = useState(true);
  const [sort, setSort] = useState<SlowSort>('Total time');
  const every = live ? LIVE_MS : false;
  const base = `/monitor/${conn.id}`;
  const isAdminRole = me?.role === 'Owner' || me?.role === 'Admin';

  const ov = useQuery({ queryKey: ['monitor', conn.id, 'overview', range], queryFn: () => api.get<MonitorOverview>(`${base}/overview?range=${range}`), refetchInterval: every });
  const alerts = useQuery({ queryKey: ['monitor', conn.id, 'alerts'], queryFn: () => api.get<MonitorAlert[]>(`${base}/alerts`), refetchInterval: every });
  const slow = useQuery({ queryKey: ['monitor', conn.id, 'slow', sort], queryFn: () => api.get<SlowStatementsResponse>(`${base}/statements?sort=${SORT_KEY[sort]}`), refetchInterval: live ? 30_000 : false });
  const locks = useQuery({ queryKey: ['monitor', conn.id, 'locks'], queryFn: () => api.get<{ rows: LockRow[] }>(`${base}/locks`), refetchInterval: every });
  const health = useQuery({ queryKey: ['monitor', conn.id, 'health'], queryFn: () => api.get<HealthResponse>(`${base}/health`), refetchInterval: live ? 300_000 : false, staleTime: 60_000 });

  const ack = useMutation({
    mutationFn: (id: number) => api.post(`${base}/alerts/${id}/ack`),
    onSuccess: () => {
      useApp.getState().toast('Alert acknowledged', 'Silenced for 4 hours. It reopens if the condition persists.', 'info');
      qc.invalidateQueries({ queryKey: ['monitor', conn.id, 'alerts'] });
    },
    onError: (e) => toastError(e, 'Could not acknowledge'),
  });

  const setRange = (r: MonitorRange) => useApp.getState().updateTab(tab.id, { params: { range: r } });

  const explain = (sql: string) => {
    const text = 'explain ' + sql.trim();
    const st = useApp.getState();
    st.openTab('query', 'explain', { sql: text }, { unique: false });
    st.set({ editorInsert: { sql: text, mode: 'replace', nonce: Date.now() } });
    st.toast('EXPLAIN drafted', 'Not run. Parameters were normalised to $1, $2… — put real values in before running.', 'info');
  };

  const kill = (l: LockRow) => {
    const call = (confirm?: string) => api.post<{ ok: boolean; released: number }>(`${base}/terminate`, { pid: l.pid, confirm });
    useApp.getState().set({
      confirm: {
        title: `Terminate pid ${l.pid}`,
        body: l.blocks > 0
          ? `This backend holds locks that ${l.blocks} other session${l.blocks > 1 ? 's are' : ' is'} waiting for. Terminating it rolls back its open transaction and releases them.`
          : 'This backend is terminated and its open transaction rolled back. Its client sees a dropped connection.',
        sql: `select pg_terminate_backend(${l.pid});\n-- ${l.user ?? '?'} · ${l.app || 'no application_name'} · ${l.state ?? ''}\n-- ${l.query.replace(/\s+/g, ' ').slice(0, 160)}`,
        word: String(l.pid),
        action: 'TERMINATE',
        onConfirm: async (typed) => {
          try {
            const r = await call(typed);
            useApp.getState().toast(`pg_terminate_backend(${l.pid})`, r.released ? `${r.released} waiter${r.released > 1 ? 's' : ''} released.` : 'Backend terminated.', 'success');
          } catch (e) {
            toastError(e, e instanceof ApiError && e.status === 403 ? 'Needs admin access on this connection' : 'Not terminated');
          }
          qc.invalidateQueries({ queryKey: ['monitor', conn.id] });
        },
      },
    });
  };

  const o = ov.data;
  const kpis = o ? buildKpis(o) : [];
  const canKill = conn.level === 'admin';
  const noSamples = o && o.totals.samples === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflowX: 'auto' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flex: 'none' }}>
          <Dot color={live ? 'var(--state-success)' : 'var(--text-muted)'} pulse={live} />
          <span style={{ ...condLabel, color: 'var(--text-secondary)' }}>{live ? 'live · 10s' : 'paused'}</span>
        </span>
        <Seg options={RANGES} value={range} onChange={setRange} />
        <Button size="sm" onClick={() => setLive(!live)}>{live ? '⏸ Pause' : '▶ Resume'}</Button>
        <span style={{ flex: 1, minWidth: 8 }} />
        {o ? (
          <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', flex: 'none' }}>
            {o.header.role === 'replica' ? 'replica · ' : ''}{o.header.host} · {o.header.version || '?'} · uptime {uptime(o.header.startedAt)}
          </span>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {ov.isLoading ? <Loading /> : ov.error ? <ErrorBox error={ov.error} onRetry={() => ov.refetch()} /> : null}
          {o?.liveError ? <Callout kind="error" title={`Cannot reach ${conn.name} right now`}>{o.liveError}</Callout> : null}
          {noSamples ? (
            <Callout kind="info" title="Collecting history">
              The sampler reads this connection once a minute; sparklines fill in as samples arrive.
              {o?.sampler.lastError ? ` Last sample failed: ${o.sampler.lastError}` : ''}
            </Callout>
          ) : null}
          {o ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(168px,1fr))', gap: 10 }}>
              {kpis.map((k) => <KpiTile key={k.label} k={k} />)}
            </div>
          ) : null}

          {alerts.data && alerts.data.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={condLabel}>Open alerts</div>
              {alerts.data.map((a) => <AlertRow key={a.id} a={a} canAck={isAdminRole} onAck={() => ack.mutate(a.id)} />)}
            </div>
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={condLabel}>Slowest statements · pg_stat_statements</span>
              <span style={{ flex: 1 }} />
              <Seg options={SLOW_SORTS} value={sort} onChange={setSort} />
            </div>
            {slow.data ? <SlowTable data={slow.data} onExplain={explain} /> : slow.error ? <ErrorBox error={slow.error} /> : <Loading />}
          </div>

          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 340, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={condLabel}>Blocking tree · pg_locks</div>
              <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
                {locks.data ? <LockTree rows={locks.data.rows} canKill={canKill} onKill={kill} /> : locks.error ? <ErrorBox error={locks.error} /> : <Loading />}
              </div>
              {!canKill && locks.data?.rows.length ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Terminating a backend needs admin access on {conn.name}.</div> : null}
            </div>
            <div style={{ flex: 1, minWidth: 340, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Label>Table health</Label>
                <span className="spacer" />
                <span style={{ ...condLabel, fontSize: 10 }}>size · bloat · last vacuum</span>
              </div>
              <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
                {health.data ? <HealthList data={health.data} /> : health.error ? <ErrorBox error={health.error} /> : <Loading />}
              </div>
              <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>
                Bloat is estimated {health.data?.pgstattuple ? 'from pgstattuple_approx samples' : 'from planner statistics (install pgstattuple for better numbers)'}, not exact — treat above 30% as a hint to look, not a verdict.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
