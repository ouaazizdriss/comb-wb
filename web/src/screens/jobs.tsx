import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConnectionSummary } from '@comb/shared';
import type { Tab } from '../lib/store.ts';
import { useApp, toastError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { until, ms as fmtMs, num, dateTime } from '../lib/format.ts';
import { Button, Seg, Toggle, Modal, TextInput, Label, Loading, ErrorBox, Empty, IDC, MONO, COND } from '../ui/index.tsx';

/** Scheduled jobs: cron-driven queries, exports, maintenance and checks that run as their owner. */

type Kind = 'query' | 'export' | 'maintenance' | 'quality' | 'refresh';
interface Options { failOnZero: boolean; retry: boolean; skipIfRunning: boolean; attachSql: boolean; attachCsv: boolean; notifyOnFailure: boolean; weekdaysOnly: boolean }
interface JobRow {
  id: string; name: string; kind: Kind; kindLabel: string; cron: string; timezone: string;
  connection: { id: string; name: string; color: string; env: string }; delivery: string; library: { id: string; name: string | null } | null;
  runs: Array<{ status: string; at: string; error: string | null }>; nextRunAt: string | null; state: 'active' | 'paused';
  owner: { id: string; label: string }; canManage: boolean;
}
interface Run { id: number; trigger: string; retry_of: number | null; attempt: number; status: string; started_at: string; finished_at: string | null; rows: number | null; ms: number | null; error: string | null; delivery: string | null }
interface JobDetail {
  id: string; name: string; kind: Kind; cron: string; timezone: string; connectionId: string; connectionName: string; sql: string | null;
  libraryId: string | null; libraryName: string | null; libraryVersion: number | null; libraryLatest: number | null; params: Record<string, string>; integrationId: string | null; options: Options;
  state: 'active' | 'paused'; nextRunAt: string | null; canManage: boolean; nextRuns: string[]; history: Run[];
}
interface Draft {
  id?: string; name: string; kind: Kind; cron: string; timezone: string; connectionId: string; sql: string | null; libraryId: string | null;
  libraryName?: string | null; params: Record<string, string>; integrationId: string | null; options: Options; state: 'active' | 'paused'; ownerIsMe?: boolean;
}

const FILTERS = ['All', 'Active', 'Paused'] as const;
const KINDS: Kind[] = ['query', 'export', 'maintenance', 'quality', 'refresh'];
const KIND_NAMES: Record<Kind, string> = { query: 'Query', export: 'Export', maintenance: 'Maintenance', quality: 'Data quality', refresh: 'Refresh' };
const DEFAULT_OPTS: Options = { failOnZero: false, retry: false, skipIfRunning: true, attachSql: false, attachCsv: false, notifyOnFailure: true, weekdaysOnly: false };
const OPTS: Array<[keyof Options, string, string]> = [
  ['failOnZero', 'Fail the run on zero rows', 'An empty report is usually a broken query, not good news.'],
  ['retry', 'Retry 3× with backoff', 'Scheduled runs only; 30 s, 1 min, 2 min apart.'],
  ['skipIfRunning', 'Skip if a previous run is still going', 'No overlapping runs of the same job.'],
  ['notifyOnFailure', 'Notify me on failure', 'An in-app notification, plus job.failed for integrations.'],
  ['weekdaysOnly', 'Only on weekdays', 'Scheduled runs on Saturday and Sunday (job timezone) are skipped.'],
  ['attachSql', 'Attach the query text to the delivery', 'Recipients can see what produced the numbers.'],
  ['attachCsv', 'Attach the result as CSV', 'Formula-safe CSV; goes only to the configured integration.'],
];
const sectionLabel: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };
const T = 'minmax(150px, 1.4fr) 112px minmax(110px, 1fr) minmax(116px, 1fr) 92px 104px 120px';
const T_MIN = 804;
const runColor = (s: string) => (s === 'ok' ? 'var(--state-success)' : s === 'running' ? 'var(--state-running)' : s === 'skipped' ? 'var(--text-muted)' : 'var(--state-error)');

function nextLabel(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const s = (d.getTime() - Date.now()) / 1000;
  if (s < 3600) return until(iso);
  const p = (x: number) => String(x).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (s < 86_400 && d.getDate() === new Date().getDate()) return hm;
  if (s < 6 * 86_400) return d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + hm;
  return dateTime(iso).slice(5);
}

function runDetail(r: Run): string {
  if (r.status === 'running') return 'running…';
  if (r.status !== 'ok') return r.error ?? r.status;
  return [r.rows !== null ? `${num(r.rows)} rows` : null, r.delivery].filter(Boolean).join(' · ');
}

export default function JobsScreen({ tab }: { tab: Tab }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const updateTab = useApp((s) => s.updateTab);
  const me = useApp((s) => s.me);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');
  const [editor, setEditor] = useState<Draft | null>(null);
  const sel: string | undefined = tab.params?.sel;

  const list = useQuery({ queryKey: ['jobs'], queryFn: () => api.get<JobRow[]>('/jobs'), refetchInterval: 30_000 });
  const jobs = (list.data ?? []).filter((j) => filter === 'All' || (filter === 'Active' ? j.state === 'active' : j.state === 'paused'));
  const selId = sel ?? jobs[0]?.id;
  const detail = useQuery({ queryKey: ['job', selId], queryFn: () => api.get<JobDetail>(`/jobs/${selId}`), enabled: !!selId, retry: false, refetchInterval: 30_000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['jobs'] }); qc.invalidateQueries({ queryKey: ['job'] }); };

  // "Schedule…" from the library hands over a draft.
  const draft = tab.params?.draft as (Partial<Draft> & { nonce: number; libraryName?: string }) | undefined;
  useEffect(() => {
    if (!draft) return;
    const conn = useApp.getState().conn;
    setEditor({ ...blank(conn?.id ?? ''), ...draft, sql: null, name: draft.name ?? 'Scheduled query' });
    updateTab(tab.id, { params: { draft: undefined } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.nonce]);

  const all = list.data ?? [];
  const weekAgo = Date.now() - 7 * 86_400_000;
  const failures = all.reduce((a, j) => a + j.runs.filter((r) => r.status === 'failed' && new Date(r.at).getTime() > weekAgo).length, 0);
  const soonest = all.map((j) => j.nextRunAt).filter(Boolean).sort()[0] ?? null;

  const toggleState = async (j: JobRow) => {
    try {
      const r = await api.patch<{ nextRunAt: string | null }>(`/jobs/${j.id}/state`, { state: j.state === 'active' ? 'paused' : 'active' });
      toast(j.name + (j.state === 'active' ? ' paused' : ' resumed'), j.state === 'active' ? 'No further runs until resumed.' : 'Next run ' + nextLabel(r.nextRunAt), 'info');
      refresh();
    } catch (e) { toastError(e); }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflowX: 'auto' }}>
        <Seg options={FILTERS} value={filter} onChange={setFilter} />
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none' }}>
          {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'} · {failures} {failures === 1 ? 'failure' : 'failures'} in 7 days · {soonest ? 'next run ' + until(soonest) : 'nothing scheduled'}
        </span>
        <span style={{ flex: 1, minWidth: 8 }} />
        <Button variant="primary" size="sm" onClick={() => setEditor(blank(useApp.getState().conn?.id ?? ''))}>+ New schedule</Button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={() => list.refetch()} /> : null}
          {list.data ? (
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: T, minWidth: T_MIN, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...sectionLabel }}>
                {['Job', 'Schedule', 'Target', 'Delivery', 'Last 7 runs', 'Next', 'State'].map((h, i) => (
                  <div key={h} style={{ padding: '5px 10px', borderRight: i < 6 ? '1px solid var(--border-subtle)' : 'none' }}>{h}</div>
                ))}
              </div>
              {jobs.map((j, i) => {
                const paused = j.state === 'paused';
                const cell: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', overflow: 'hidden' };
                return (
                  <div key={j.id} className="row-hover" onClick={() => updateTab(tab.id, { params: { sel: j.id } })}
                    style={{ display: 'grid', gridTemplateColumns: T, minWidth: T_MIN, height: 42, borderBottom: i < jobs.length - 1 ? '1px solid var(--border-subtle)' : 'none', cursor: 'pointer', opacity: paused ? 0.62 : 1, background: selId === j.id ? 'var(--bg-selected)' : 'transparent' }}>
                    <div style={{ ...cell, flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center' }}>
                      <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.name}</span>
                      <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.kindLabel}</span>
                    </div>
                    <div title={j.timezone} style={{ ...cell, fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{j.cron}</div>
                    <div style={{ ...cell, gap: 6 }}>
                      <span style={{ width: 2, height: 12, flex: 'none', background: IDC[j.connection.color] ?? IDC.slate }} />
                      <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.connection.name}</span>
                    </div>
                    <div style={{ ...cell, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{j.delivery}</div>
                    <div style={{ ...cell, gap: 3 }}>
                      {j.runs.length ? j.runs.map((r, k) => (
                        <span key={k} title={`${dateTime(r.at)} ${r.status}${r.error ? ': ' + r.error : ''}`} style={{ width: 7, height: 14, flex: 'none', background: runColor(r.status), opacity: r.status === 'ok' ? 0.75 : 1 }} />
                      )) : <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>no runs yet</span>}
                    </div>
                    <div style={{ ...cell, fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : undefined}>{paused ? '—' : nextLabel(j.nextRunAt)}</div>
                    <div style={{ ...cell, gap: 8, borderRight: 'none' }}>
                      <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', whiteSpace: 'nowrap', color: paused ? 'var(--text-muted)' : 'var(--state-success)' }}>{paused ? 'PAUSED' : 'ACTIVE'}</span>
                      <span style={{ flex: 1 }} />
                      {j.canManage ? (
                        <button className="hov-text" onClick={(e) => { e.stopPropagation(); toggleState(j); }} style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{paused ? 'resume' : 'pause'}</button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {!jobs.length ? (
                <Empty title={all.length ? 'No job matches' : 'No scheduled jobs'} body={all.length ? undefined : 'Schedule a saved query or any SQL: a report, an export, a VACUUM, a data-quality check. Runs execute as you, with your access re-checked every time.'} />
              ) : null}
            </div>
          ) : null}
          {selId && detail.data ? (
            <Detail key={detail.data.id} j={detail.data} meId={me?.id ?? ''} owner={all.find((x) => x.id === selId)?.owner}
              onChanged={refresh} onEdit={() => setEditor(toDraft(detail.data!, all.find((x) => x.id === selId)?.owner.id === me?.id))}
              onDeleted={() => { updateTab(tab.id, { params: { sel: undefined } }); refresh(); }} />
          ) : selId && detail.error ? <ErrorBox error={detail.error} /> : null}
        </div>
      </div>
      {editor ? <Editor init={editor} onClose={() => setEditor(null)} onSaved={(id) => { setEditor(null); updateTab(tab.id, { params: { sel: id } }); refresh(); }} /> : null}
    </div>
  );
}

function blank(connId: string): Draft {
  return { name: '', kind: 'query', cron: '0 7 * * MON', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', connectionId: connId, sql: '', libraryId: null, params: {}, integrationId: null, options: { ...DEFAULT_OPTS }, state: 'active', ownerIsMe: true };
}
function toDraft(j: JobDetail, ownerIsMe: boolean): Draft {
  return { id: j.id, name: j.name, kind: j.kind, cron: j.cron, timezone: j.timezone, connectionId: j.connectionId, sql: j.libraryId ? null : j.sql, libraryId: j.libraryId,
    libraryName: j.libraryName, params: j.params, integrationId: j.integrationId, options: { ...DEFAULT_OPTS, ...j.options }, state: j.state, ownerIsMe };
}
function bodyOf(d: Draft) {
  return { name: d.name, kind: d.kind, cron: d.cron, timezone: d.timezone, connectionId: d.connectionId, sql: d.libraryId ? null : d.sql, libraryId: d.libraryId,
    params: d.params, integrationId: d.integrationId || null, options: d.options, state: d.state };
}

function Detail({ j, meId, owner, onChanged, onEdit, onDeleted }: { j: JobDetail; meId: string; owner?: { id: string; label: string }; onChanged: () => void; onEdit: () => void; onDeleted: () => void }) {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const ownerIsMe = owner?.id === meId;
  const runNow = async (retryOf?: number) => {
    setBusy(true);
    try {
      const r = await api.post<Run>(retryOf ? `/jobs/runs/${retryOf}/retry` : `/jobs/${j.id}/run`, {});
      toast(r.status === 'ok' ? `${j.name}: ${runDetail(r)}` : `${j.name} failed`, r.status === 'ok' ? 'Ad-hoc run. It does not shift the schedule.' : r.error ?? undefined, r.status === 'ok' ? 'success' : 'error');
      onChanged();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const setOpt = async (k: keyof Options, v: boolean) => {
    try {
      await api.put(`/jobs/${j.id}`, bodyOf({ ...toDraft(j, ownerIsMe), options: { ...j.options, [k]: v } }));
      if (!ownerIsMe) toast('You now own this job', 'Changes make the editor the owner, so runs use your access.', 'info');
      onChanged();
    } catch (e) { toastError(e); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the job "${j.name}" and its run history?`)) return;
    try { await api.del(`/jobs/${j.id}`); toast('Deleted ' + j.name); onDeleted(); } catch (e) { toastError(e); }
  };
  const newer = j.libraryId && j.libraryVersion && j.libraryLatest && j.libraryLatest > j.libraryVersion;
  const sqlText = j.libraryId ? `-- saved query: ${j.libraryName ?? '(deleted)'} · v${j.libraryVersion ?? '?'}${Object.keys(j.params).length ? '\n-- params: ' + Object.entries(j.params).map(([k, v]) => `:${k} = ${JSON.stringify(v)}`).join(', ') : ''}\n${j.sql ?? ''}` : j.sql ?? '';
  return (
    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 330, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={sectionLabel}>Run history · {j.name}</span>
          <span className="spacer" />
          {j.canManage ? <Button size="sm" disabled={busy} onClick={() => runNow()}>{busy ? 'Running…' : 'Run now'}</Button> : null}
        </div>
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
          {j.history.map((h, i) => {
            const failed = h.status === 'failed';
            return (
              <div key={h.id} title={h.error ?? undefined} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', height: 30, borderTop: i ? '1px solid var(--border-subtle)' : 'none', background: failed ? 'color-mix(in oklab, var(--state-error) 8%, transparent)' : 'transparent' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', flex: 'none', background: runColor(h.status) }} />
                <span style={{ fontFamily: MONO, fontSize: 12, width: 104, flex: 'none' }}>{dateTime(h.started_at).slice(5)}</span>
                <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {h.trigger !== 'schedule' ? <span style={{ color: 'var(--text-muted)' }}>{h.trigger === 'retry' ? `retry${h.retry_of ? ' of #' + h.retry_of : ''}` : 'manual'} · </span> : null}{runDetail(h)}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtMs(h.ms)}</span>
                {failed && j.canManage ? <button onClick={() => runNow(h.id)} disabled={busy} style={{ fontSize: 11, color: 'var(--state-info)', whiteSpace: 'nowrap' }}>retry</button> : null}
              </div>
            );
          })}
          {!j.history.length ? <div style={{ padding: '16px 10px', fontSize: 12, color: 'var(--text-muted)' }}>No runs yet. {j.state === 'active' && j.nextRunAt ? `First run ${until(j.nextRunAt)}.` : ''}</div> : null}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', lineHeight: '17px' }}>
          {j.state === 'active' ? <>next: {j.nextRuns.slice(0, 5).map((d) => dateTime(d).slice(5)).join(' · ') || '—'} ({j.timezone})</> : 'paused — no runs until resumed'}
          <br />runs as {ownerIsMe ? 'you' : owner?.label ?? 'its owner'}, with access re-checked at every run
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 330, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={sectionLabel}>Definition</span>
          <span className="spacer" />
          {j.canManage ? <><Button size="sm" onClick={onEdit}>Edit</Button><Button size="sm" variant="danger-ghost" onClick={remove}>Delete</Button></> : null}
        </div>
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', padding: '10px 12px' }}>
          <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: '19px', whiteSpace: 'pre-wrap' }}>{sqlText}</pre>
        </div>
        {j.libraryId ? (
          <span style={{ fontSize: 11, color: newer ? 'var(--state-running)' : 'var(--text-muted)' }}>
            {newer ? `Pinned to v${j.libraryVersion}; the saved query is now at v${j.libraryLatest}. Saving the job picks up the newer version.` : `Pinned to v${j.libraryVersion ?? '?'} of the saved query. Later edits to it do not change what this job runs until the job is saved again.`}
          </span>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: 10, border: '1px solid var(--border-subtle)', borderRadius: 3 }}>
          {OPTS.map(([k, label, hint]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}><span style={{ fontSize: 13, lineHeight: '18px' }}>{label}</span><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</span></div>
              <Toggle on={!!j.options[k]} onChange={(v) => setOpt(k, v)} disabled={!j.canManage} title={j.canManage ? undefined : 'Only the owner or an Admin can change this job'} />
            </div>
          ))}
          {j.canManage && !ownerIsMe ? <span style={{ fontSize: 11, color: 'var(--state-running)' }}>Saving any change makes you the owner of this job.</span> : null}
        </div>
      </div>
    </div>
  );
}

function Editor({ init, onClose, onSaved }: { init: Draft; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useApp((s) => s.toast);
  const [d, setD] = useState<Draft>(init);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const conns = useQuery({ queryKey: ['connections'], queryFn: () => api.get<ConnectionSummary[]>('/connections') });
  const integrations = useQuery({ queryKey: ['integrations-list'], queryFn: () => api.get<Array<{ id: string; name?: string; kind?: string }>>('/integrations'), retry: false });
  const [debounced, setDebounced] = useState({ cron: d.cron, tz: d.timezone });
  useEffect(() => { const t = setTimeout(() => setDebounced({ cron: d.cron, tz: d.timezone }), 250); return () => clearTimeout(t); }, [d.cron, d.timezone]);
  const preview = useQuery({
    queryKey: ['cron-preview', debounced.cron, debounced.tz],
    queryFn: () => api.get<{ ok: boolean; error?: string; next: string[] }>(`/jobs/cron/preview?cron=${encodeURIComponent(debounced.cron)}&tz=${encodeURIComponent(debounced.tz)}`),
    enabled: !!debounced.cron.trim(),
  });
  const conn = conns.data?.find((c) => c.id === d.connectionId);
  const integrationList = Array.isArray(integrations.data) ? integrations.data : null;
  const save = async () => {
    setBusy(true);
    try {
      const r = d.id ? (await api.put(`/jobs/${d.id}`, bodyOf(d)), { id: d.id }) : await api.post<{ id: string }>('/jobs', bodyOf(d));
      toast(d.id ? 'Schedule saved' : 'Schedule created', preview.data?.next?.[0] ? 'First run ' + until(preview.data.next[0]) : undefined, 'success');
      onSaved(r.id);
    } catch (e) { toastError(e, 'Could not save the schedule'); } finally { setBusy(false); }
  };
  return (
    <Modal title={d.id ? `Edit ${init.name}` : 'New schedule'} onClose={onClose} width={700}
      footer={<>
        <span style={{ fontSize: 12, color: d.id && !d.ownerIsMe ? 'var(--state-running)' : 'var(--text-muted)' }}>
          {d.id && !d.ownerIsMe ? 'Saving makes you the owner of this job.' : 'Runs execute as you, with your access re-checked every time.'}
        </span>
        <span className="spacer" /><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !d.name.trim() || !d.connectionId || (!d.libraryId && !d.sql?.trim()) || preview.data?.ok === false} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Name"><TextInput value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} placeholder="MRR weekly report" /></Field>
        <Field label="Kind"><Seg options={KINDS} value={d.kind} onChange={(k) => set({ kind: k })} labels={KIND_NAMES} /></Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Connection" style={{ flex: 1 }}>
            <select value={d.connectionId} onChange={(e) => set({ connectionId: e.target.value })} style={{ height: 28, padding: '0 6px', border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', fontFamily: MONO, fontSize: 12 }}>
              <option value="">choose…</option>
              {(conns.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.env}{c.requireApproval ? ' · approval' : ''}</option>)}
            </select>
          </Field>
          <Field label="Delivery" style={{ flex: 1 }}>
            {integrationList ? (
              <select value={d.integrationId ?? ''} onChange={(e) => set({ integrationId: e.target.value || null })} style={{ height: 28, padding: '0 6px', border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', fontSize: 12 }}>
                <option value="">Store result only</option>
                {integrationList.map((i) => <option key={i.id} value={i.id}>{i.name ?? i.id}{i.kind ? ' · ' + i.kind : ''}</option>)}
              </select>
            ) : (
              <TextInput value={d.integrationId ?? ''} onChange={(e) => set({ integrationId: e.target.value || null })} placeholder="integration id — empty stores the result only" />
            )}
          </Field>
        </div>
        {conn?.requireApproval ? <span style={{ fontSize: 12, color: 'var(--state-running)' }}>{conn.name} requires approval for writes: jobs there may only run read statements.</span> : null}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Field label="Cron (min hour day month weekday)" style={{ flex: 1 }}><TextInput mono value={d.cron} onChange={(e) => set({ cron: e.target.value })} placeholder="0 7 * * MON" /></Field>
          <Field label="Timezone" style={{ width: 200 }}><TextInput mono value={d.timezone} onChange={(e) => set({ timezone: e.target.value })} placeholder="Europe/Paris" /></Field>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, lineHeight: '17px', color: preview.data?.ok === false ? 'var(--state-error)' : 'var(--text-muted)', marginTop: -6 }}>
          {preview.data?.ok === false ? preview.data.error : preview.data?.next?.length ? 'next: ' + preview.data.next.map((x) => dateTime(x).slice(5)).join(' · ') + ' (your local time)' : ' '}
        </div>
        {d.libraryId ? (
          <Field label="Saved query">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: MONO, fontSize: 12 }}>⌗ {d.libraryName ?? d.libraryId}</span>
              <span className="spacer" />
              <Button size="sm" variant="ghost" onClick={() => set({ libraryId: null, sql: '' })}>use SQL instead</Button>
            </div>
            {Object.keys(d.params).length ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                {Object.keys(d.params).map((p) => (
                  <label key={p} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-secondary)' }}>:{p}</span>
                    <TextInput mono value={d.params[p]} onChange={(e) => set({ params: { ...d.params, [p]: e.target.value } })} style={{ height: 24, width: 150 }} />
                  </label>
                ))}
              </div>
            ) : null}
          </Field>
        ) : (
          <Field label="SQL">
            <textarea value={d.sql ?? ''} onChange={(e) => set({ sql: e.target.value })} spellCheck={false} rows={7} placeholder={d.kind === 'maintenance' ? 'vacuum (analyze) public.events;' : d.kind === 'quality' ? '-- rows returned = violations\nselect id from orders where total < 0;' : 'select …'}
              style={{ fontFamily: MONO, fontSize: 12, lineHeight: '19px', padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-inset)', resize: 'vertical' }} />
            {d.kind === 'quality' ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>A data-quality run fails when the query returns any row.</span> : null}
          </Field>
        )}
        <Field label="Options">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
            {OPTS.map(([k, label]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 12 }}>{label}</span>
                <Toggle on={!!d.options[k]} onChange={(v) => set({ options: { ...d.options, [k]: v } })} />
              </div>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children, style }: { label: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, ...style }}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}


