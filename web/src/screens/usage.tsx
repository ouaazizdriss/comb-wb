import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tab } from '../lib/store.ts';
import { useApp, useConn, toastError } from '../lib/store.ts';
import { api, downloadFrom } from '../lib/api.ts';
import { ms as fmtMs, num } from '../lib/format.ts';
import { Empty, ErrorBox, Loading, MONO, COND, Seg, TextInput } from '../ui/index.tsx';

/*
 * Usage & cost: compute time attributed from the audit trail (per statement ms, rows, actor, kind),
 * priced at the connection's instance rate. Query text arrives already normalised (no literals).
 */

const RANGES = ['this_month', 'last_month', '90d'] as const;
type Range = (typeof RANGES)[number];
const RANGE_LABEL: Record<Range, string> = { this_month: 'This month', last_month: 'Last month', '90d': '90 days' };
const RANGE_NOUN: Record<Range, string> = { this_month: 'this month', last_month: 'last month', '90d': 'in the last 90 days' };

interface Kpi { value: number; delta: number | null }
interface TeamRow { team: string; read: number; write: number; schema: number; statements: number; ms: number; hours: number; cost: number }
interface Usage {
  range: Range; from: string; to: string; rate: number; defaultRate: number; members: number;
  kpis: { cost: Kpi; hours: Kpi; statements: Kpi; rowsRead: Kpi; costPerStatement: Kpi };
  teams: TeamRow[];
  expensive: Array<{ query: string; who: string; calls: number; ms: number; cost: number }>;
  savings: Array<{ title: string; body: string; saving: string }>;
  server: { available: true; totalMs: number; calls: number; top: Array<{ query: string; calls: number; ms: number; rows: number }> } | { available: false; reason: string };
}
interface Member { id: string; name: string | null; email: string; role: string; team: string | null }

const SEGS = [
  { key: 'read', label: 'reads', color: 'var(--state-info)' },
  { key: 'write', label: 'writes', color: 'var(--type-temporal)' },
  { key: 'schema', label: 'schema changes', color: 'var(--type-structured)' },
] as const;

const label: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };
const box: React.CSSProperties = { border: '1px solid var(--border-subtle)', borderRadius: 3 };
const tbtn: React.CSSProperties = { height: 22, padding: '0 9px', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 12, whiteSpace: 'nowrap', flex: 'none' };

function money(n: number): string {
  if (n >= 100) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 0.01) return '$' + n.toFixed(2);
  if (n >= 0.0001) return '$' + n.toFixed(4);
  return n > 0 ? '<$0.0001' : '$0';
}
function hours(h: number): string {
  if (h >= 10) return Math.round(h).toLocaleString('en-US') + ' h';
  if (h >= 1) return h.toFixed(1) + ' h';
  return fmtMs(h * 3_600_000);
}
function compact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  return num(Math.round(n));
}
function deltaText(d: number | null): string {
  if (d === null || !Number.isFinite(d)) return 'new';
  const p = Math.round(d * 100);
  return p === 0 ? '±0%' : (p > 0 ? '+' : '−') + Math.abs(p) + '%';
}

export default function UsageScreen({ tab }: { tab: Tab }) {
  const conn = useConn();
  const me = useApp((s) => s.me);
  const toast = useApp((s) => s.toast);
  const updateTab = useApp((s) => s.updateTab);
  const admin = me?.role === 'Owner' || me?.role === 'Admin';
  const range = (RANGES.includes(tab.params?.range) ? tab.params!.range : 'this_month') as Range;
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['usage', conn.id, range],
    queryFn: () => api.get<Usage>(`/usage/${conn.id}?range=${range}`),
    enabled: admin,
  });
  const [exporting, setExporting] = useState(false);

  if (!admin) return <Empty title="Usage & cost is for Admins" body="Compute attribution and chargeback are visible to workspace Owners and Admins." />;

  async function exportCsv() {
    setExporting(true);
    try {
      await downloadFrom(`/usage/${conn.id}/chargeback.csv?range=${range}`, `chargeback-${conn.name}-${range}.csv`);
      toast('Chargeback CSV downloaded', 'Per-team and per-member compute hours with the attributed cost. The export is in the trail.', 'success');
    } catch (e) {
      toastError(e, 'Chargeback export failed');
    } finally {
      setExporting(false);
    }
  }

  const k = data?.kpis;
  const kpis = k ? [
    { value: money(k.cost.value), delta: k.cost.delta, label: 'Attributed spend' },
    { value: hours(k.hours.value), delta: k.hours.delta, label: 'Compute time' },
    { value: compact(k.statements.value), delta: k.statements.delta, label: 'Statements' },
    { value: compact(k.rowsRead.value), delta: k.rowsRead.delta, label: 'Rows read' },
    { value: money(k.costPerStatement.value), delta: k.costPerStatement.delta, label: 'Cost per statement' },
  ] : [];

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflowX: 'auto' }}>
        <Seg options={RANGES} value={range} labels={RANGE_LABEL} onChange={(r) => updateTab(tab.id, { params: { ...tab.params, range: r } })} />
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none' }}>
          {data ? `${money(data.kpis.cost.value)} attributed · ${hours(data.kpis.hours.value)} compute · ${data.members} member${data.members === 1 ? '' : 's'}` : isFetching ? 'Loading…' : ''}
        </span>
        <span style={{ flex: 1, minWidth: 8 }} />
        {data ? <RateEditor connId={conn.id} rate={data.rate} defaultRate={data.defaultRate} /> : null}
        <button className="hov" disabled={exporting || !data} onClick={() => void exportCsv()} style={tbtn}>⤓ Chargeback CSV</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {isLoading ? <Loading label="Attributing compute time…" /> : error ? <ErrorBox error={error} onRetry={() => void refetch()} /> : data ? (
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
              {kpis.map((x) => {
                const up = x.delta !== null && x.delta > 0;
                // As in the mockup: growth reads amber, a drop reads green.
                const good = x.delta === null || x.delta === 0 ? null : !up;
                return (
                  <div key={x.label} style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '10px 11px', ...box, background: 'var(--bg-raised)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ fontFamily: MONO, fontSize: 22, lineHeight: '28px', fontWeight: 500 }}>{x.value}</span>
                      <span title="vs. the previous period of the same length" style={{ fontFamily: MONO, fontSize: 11, color: good === null ? 'var(--text-muted)' : good ? 'var(--state-success)' : 'var(--state-running)' }}>{deltaText(x.delta)}</span>
                    </div>
                    <span style={label}>{x.label}</span>
                  </div>
                );
              })}
            </div>

            <TeamBars teams={data.teams} />

            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 330, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={label}>Most expensive queries {RANGE_NOUN[range]}</div>
                <div style={{ ...box, overflow: 'hidden' }}>
                  {data.expensive.length === 0 ? (
                    <div style={{ padding: '10px', fontSize: 12, color: 'var(--text-muted)' }}>No statements on this connection in this period.</div>
                  ) : data.expensive.map((c, i) => (
                    <div key={i} className="row-hover" title={`${c.query}\n\n${num(c.calls)} run${c.calls === 1 ? '' : 's'} · ${fmtMs(c.ms)} total`}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 30, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
                      <span style={{ fontFamily: MONO, fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.query}</span>
                      <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{c.calls > 1 ? `×${compact(c.calls)} · ` : ''}{c.who}</span>
                      <span style={{ fontFamily: MONO, fontSize: 12, width: 66, flex: 'none', textAlign: 'right' }}>{money(c.cost)}</span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>
                  Cost is compute seconds × your instance rate. It is an attribution, not an invoice. Literal values are stripped from the query text.
                </div>
                <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>
                  {data.server.available
                    ? `pg_stat_statements: ${compact(data.server.calls)} calls, ${hours(data.server.totalMs / 3_600_000)} of execution on the server since its statistics were reset (all clients, not only Comb).`
                    : `Figures come from Comb's audit trail only — ${data.server.reason}.`}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 330, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={label}>Where the money goes</div>
                <div style={{ ...box, padding: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {data.savings.length === 0 ? (
                    <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>Nothing stands out: no seq-scan-heavy tables, unused indexes, bloated tables or repeated queries worth caching.</span>
                  ) : data.savings.map((s, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
                      <span style={{ fontSize: 11, color: 'var(--state-running)', width: 12, flex: 'none', paddingTop: 3 }}>⚡</span>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13, lineHeight: '18px' }}>{s.title}</span>
                        <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{s.body}</span>
                      </div>
                      <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--state-success)', whiteSpace: 'nowrap' }}>{s.saving}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <Teams />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TeamBars({ teams }: { teams: TeamRow[] }) {
  const max = Math.max(1e-9, ...teams.map((t) => t.ms));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={label}>Query time by team</div>
      <div style={{ ...box, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {teams.length === 0 ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No query time recorded in this period.</span> : teams.map((t) => (
          <div key={t.team} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span title={t.team} style={{ fontSize: 12, width: 110, flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.team === 'Unassigned' ? 'var(--text-muted)' : undefined }}>{t.team}</span>
            <div style={{ flex: 1, minWidth: 80, height: 14, background: 'var(--bg-inset)', borderRadius: 2, overflow: 'hidden', display: 'flex' }}>
              {SEGS.map((s) => {
                const v = t[s.key];
                if (!v) return null;
                const pct = t.ms ? Math.round((100 * v) / t.ms) : 0;
                return <span key={s.key} title={`${s.label} ${pct}% · ${fmtMs(v)}`} style={{ width: (100 * v) / max + '%', background: s.color, height: '100%', display: 'block' }} />;
              })}
            </div>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', width: 74, flex: 'none', textAlign: 'right' }}>{hours(t.hours)}</span>
            <span style={{ fontFamily: MONO, fontSize: 12, width: 74, flex: 'none', textAlign: 'right' }}>{money(t.cost)}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', paddingTop: 9, borderTop: '1px solid var(--border-subtle)' }}>
          {SEGS.map((s) => (
            <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
              <span style={{ width: 9, height: 9, background: s.color, flex: 'none' }} />{s.label}
            </span>
          ))}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Members without a team count as Unassigned. Map them below.</span>
        </div>
      </div>
    </div>
  );
}

function RateEditor({ connId, rate, defaultRate }: { connId: string; rate: number; defaultRate: number }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [edit, setEdit] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (v: number) => api.put(`/usage/${connId}/rate`, { usdPerHour: v }),
    onSuccess: (_r, v) => { setEdit(null); void qc.invalidateQueries({ queryKey: ['usage', connId] }); toast('Instance rate updated', `${money(v)}/h from now on, applied to every period shown. The change is in the trail.`, 'success'); },
    onError: (e) => toastError(e, 'Rate not saved'),
  });
  if (edit === null) {
    return (
      <button className="hov" onClick={() => setEdit(String(rate))} title={`Instance rate for this connection (default $${defaultRate}/h). Click to change.`}
        style={{ ...tbtn, border: '1px solid var(--border-subtle)', fontFamily: MONO, color: 'var(--text-secondary)' }}>${rate}/h</button>
    );
  }
  const v = Number(edit);
  const ok = edit.trim() !== '' && Number.isFinite(v) && v >= 0 && v <= 10_000;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ok) save.mutate(v); }} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>$/h</span>
      <TextInput mono autoFocus value={edit} onChange={(e) => setEdit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEdit(null); }} style={{ width: 70, height: 22 }} />
      <button type="submit" className="hov" disabled={!ok || save.isPending} style={tbtn}>Save</button>
      <button type="button" onClick={() => setEdit(null)} style={{ fontSize: 12, color: 'var(--text-muted)' }}>Cancel</button>
    </form>
  );
}

function Teams() {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['usage', 'teams'], queryFn: () => api.get<{ members: Member[]; teams: string[] }>('/usage/teams') });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: ({ id, team }: { id: string; team: string }) => api.put(`/usage/teams/${id}`, { team: team.trim() || null }),
    onSuccess: (_r, { id, team }) => {
      setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });
      void qc.invalidateQueries({ queryKey: ['usage'] });
      toast(team.trim() ? `Moved to ${team.trim()}` : 'Team cleared', 'Attribution is recomputed for every period. The change is in the trail.', 'info');
    },
    onError: (e) => toastError(e, 'Team not saved'),
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={label}>Teams</div>
      {isLoading ? <Loading /> : error ? <ErrorBox error={error} onRetry={() => void refetch()} /> : (
        <div style={{ ...box, overflow: 'hidden', maxWidth: 720 }}>
          <datalist id="usage-teams">{data!.teams.map((t) => <option key={t} value={t} />)}</datalist>
          {data!.members.map((m, i) => {
            const draft = drafts[m.id];
            const value = draft ?? m.team ?? '';
            const dirty = draft !== undefined && draft.trim() !== (m.team ?? '');
            const commit = () => { if (dirty) save.mutate({ id: m.id, team: draft! }); };
            return (
              <div key={m.id} className="row-hover" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 32, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
                <span style={{ fontSize: 12, width: 160, flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name || m.email.split('@')[0]}</span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.email} · {m.role}</span>
                <TextInput list="usage-teams" placeholder="Unassigned" value={value} aria-label={`Team for ${m.email}`}
                  onChange={(e) => setDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                  onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDrafts((d) => { const n = { ...d }; delete n[m.id]; return n; }); }}
                  style={{ width: 170, height: 22 }} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
