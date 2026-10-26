import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tab } from '../lib/store.ts';
import { useApp, useConn, toastError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { ago, ms as fmtMs, num } from '../lib/format.ts';
import { useTree } from '../lib/tree.ts';
import { Button, ErrorBox, Loading, Modal, MONO, COND, Seg, Toggle, TextInput, Callout } from '../ui/index.tsx';

/*
 * Data quality: tests are queries that return the offending rows. Runs are read-only and
 * audited on the server; offending rows come back masked and capped at 4.
 */

const KINDS = ['not_null', 'unique', 'accepted_values', 'freshness', 'row_count_min', 'referential', 'custom'] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABEL: Record<Kind, string> = {
  not_null: 'not null', unique: 'unique', accepted_values: 'accepted values', freshness: 'freshness', row_count_min: 'row count', referential: 'relationship', custom: 'custom SQL',
};
const FILTERS = ['All', 'Failing', 'Muted'] as const;

interface Run { state: 'pass' | 'fail' | 'error'; failing: number | null; at: string }
interface Test {
  id: string; name: string; kind: Kind; schema: string; table: string; column: string | null; target: string; rule: string; sql: string;
  severity: 'info' | 'warn' | 'critical'; schedule: string | null; options: { notify?: boolean; blockExport?: boolean; runOnSchedule?: boolean };
  muted: boolean; lastRunAt: string | null; lastState: 'pass' | 'fail' | 'error' | null; failing: number | null; lastMs: number | null; runs: Run[];
}
interface Detail extends Test { last: { at: string; state: string; failing: number | null; ms: number; error: string | null; columns: string[] | null; sample: unknown[][] | null } | null }

const T = 'minmax(200px,1fr) 200px 120px 84px 104px 130px';
const cell: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', overflow: 'hidden', minWidth: 0 };
const label: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };
const failingNow = (t: Test) => t.lastState === 'fail' && !t.muted;

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return `'${String(v)}'`;
}

export default function QualityScreen({ tab }: { tab: Tab }) {
  const conn = useConn();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const updateTab = useApp((s) => s.updateTab);
  const filter = (tab.params?.filter ?? 'All') as (typeof FILTERS)[number];
  const sel: string | null = tab.params?.sel ?? null;
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const key = ['quality', conn.id];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.get<{ tests: Test[]; canEdit: boolean }>(`/quality/${conn.id}/tests`) });
  const tests = data?.tests ?? [];
  const shown = useMemo(() => tests.filter((t) => (filter === 'Muted' ? t.muted : filter === 'Failing' ? failingNow(t) : true)), [tests, filter]);
  const setParams = (p: Record<string, unknown>) => updateTab(tab.id, { params: p });

  const mute = useMutation({
    mutationFn: (t: Test) => api.patch(`/quality/${conn.id}/tests/${t.id}`, { muted: !t.muted }),
    onSuccess: (_r, t) => {
      toast(t.muted ? 'Unmuted' : 'Muted ' + t.name, t.muted ? 'It counts against the suite again.' : 'It still runs — it just stops notifying anyone. Muting is recorded.', 'info');
      void qc.invalidateQueries({ queryKey: ['quality', conn.id] });
    },
    onError: (e) => toastError(e),
  });

  async function runAll() {
    if (progress || !tests.length) return;
    const list = tests;
    const started = Date.now();
    let failed = 0;
    const lines: string[] = [];
    setProgress({ done: 0, total: list.length });
    for (let i = 0; i < list.length; i++) {
      try {
        const r = await api.post<{ state: string; failing: number | null }>(`/quality/${conn.id}/tests/${list[i].id}/run`);
        if (r.state !== 'pass' && !list[i].muted) { failed++; if (lines.length < 2) lines.push(r.state === 'error' ? `${list[i].name} errored` : `${list[i].name}: ${num(r.failing)} offending`); }
      } catch (e) {
        failed++;
        lines.push(`${list[i].name}: ${(e as Error).message}`);
      }
      setProgress({ done: i + 1, total: list.length });
    }
    setProgress(null);
    void qc.invalidateQueries({ queryKey: ['quality', conn.id] });
    toast(`${list.length} test${list.length === 1 ? '' : 's'} ran in ${fmtMs(Date.now() - started)}`, failed ? `${failed} failing: ${lines.join(', ')}.` : 'Everything passes.', failed ? 'error' : 'success');
  }

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={() => void refetch()} />;
  const lastRun = tests.map((t) => t.lastRunAt).filter(Boolean).sort().pop();
  const current = tests.find((t) => t.id === sel) ?? null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflowX: 'auto' }}>
        <Seg options={FILTERS} value={filter} onChange={(f) => setParams({ filter: f })} />
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none' }}>
          {tests.filter(failingNow).length} failing of {tests.length}{lastRun ? ` · ran ${ago(lastRun)}` : ' · never run'}
        </span>
        <span style={{ flex: 1, minWidth: 8 }} />
        <button onClick={() => void runAll()} disabled={!tests.length}
          style={{ height: 22, padding: '0 10px', borderRadius: 3, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', flex: 'none',
            background: progress ? 'var(--bg-hover)' : 'var(--btn-primary)', color: progress ? 'var(--state-running)' : 'var(--text-inverse)' }}>
          {progress ? `running ${progress.done}/${progress.total}…` : '▷ Run all'}
        </button>
        {data?.canEdit ? (
          <button className="hov" onClick={() => setCreating(true)} style={{ height: 22, padding: '0 9px', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 12, whiteSpace: 'nowrap', flex: 'none' }}>+ New test</button>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: T, minWidth: 840, position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...label }}>
            {['Test', 'Target', 'Kind', 'Failing', 'Last 10', 'State'].map((h, i) => (
              <div key={h} style={{ padding: '5px 10px', borderRight: i < 5 ? '1px solid var(--border-subtle)' : 'none', textAlign: h === 'Failing' ? 'right' : 'left' }}>{h}</div>
            ))}
          </div>
          {shown.map((t) => {
            const failing = failingNow(t);
            return (
              <div key={t.id} className="row-hover" onClick={() => setParams({ sel: t.id })}
                style={{ display: 'grid', gridTemplateColumns: T, minWidth: 840, height: 30, borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', opacity: t.muted ? 0.6 : 1,
                  background: sel === t.id ? 'var(--bg-selected)' : failing ? 'color-mix(in oklab, var(--state-error) 7%, transparent)' : undefined }}>
                <div style={{ ...cell, fontSize: 12, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {t.severity === 'critical' ? <span title="critical" style={{ color: 'var(--state-error)', marginRight: 6 }}>●</span> : null}{t.name}
                </div>
                <div style={{ ...cell, fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{t.target}</div>
                <div style={cell}><span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{KIND_LABEL[t.kind]}</span></div>
                <div style={{ ...cell, justifyContent: 'flex-end', fontFamily: MONO, fontSize: 12, color: t.failing ? 'var(--state-error)' : 'var(--text-muted)' }}>{t.failing ? num(t.failing) : '—'}</div>
                <div style={{ ...cell, gap: 2 }}>
                  {t.runs.length ? t.runs.slice(-10).map((r, i) => (
                    <span key={i} title={`${ago(r.at)} · ${r.state}${r.failing ? ' · ' + num(r.failing) : ''}`}
                      style={{ width: 6, height: 13, flex: 'none', background: r.state === 'pass' ? 'var(--state-success)' : r.state === 'error' ? 'var(--state-running)' : 'var(--state-error)', opacity: r.state === 'pass' ? 0.7 : 1 }} />
                  )) : <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>no runs</span>}
                </div>
                <div style={{ ...cell, borderRight: 'none', gap: 8 }}>
                  <span style={{ fontFamily: MONO, fontSize: 12, whiteSpace: 'nowrap', color: t.muted ? 'var(--text-muted)' : t.lastState === 'fail' ? 'var(--state-error)' : t.lastState === 'error' ? 'var(--state-running)' : t.lastState === 'pass' ? 'var(--state-success)' : 'var(--text-muted)' }}>
                    {t.muted ? 'MUTED' : t.lastState === 'fail' ? '✕ fail' : t.lastState === 'error' ? '⚠ error' : t.lastState === 'pass' ? '✓ pass' : '· new'}
                  </span>
                  <span style={{ flex: 1 }} />
                  {data?.canEdit ? (
                    <button className="hov-text" onClick={(e) => { e.stopPropagation(); mute.mutate(t); }} style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{t.muted ? 'unmute' : 'mute'}</button>
                  ) : null}
                </div>
              </div>
            );
          })}
          {!shown.length ? (
            <div style={{ padding: '44px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: 24, lineHeight: '30px', fontWeight: 600, marginBottom: 6 }}>{tests.length ? 'Nothing in this view.' : 'No tests yet.'}</div>
              <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)', maxWidth: 520, margin: '0 auto' }}>
                Pick a column and a kind — unique, not null, accepted values, relationship, freshness — or write the SQL that should return zero rows.
              </div>
              {data?.canEdit && !tests.length ? <div style={{ marginTop: 14 }}><Button variant="primary" onClick={() => setCreating(true)}>+ New test</Button></div> : null}
            </div>
          ) : null}
        </div>
        {current ? <TestPanel test={current} canEdit={!!data?.canEdit} onClose={() => setParams({ sel: null })} /> : null}
      </div>
      {creating ? <NewTest onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setParams({ sel: id }); }} /> : null}
    </div>
  );
}

function TestPanel({ test, canEdit, onClose }: { test: Test; canEdit: boolean; onClose: () => void }) {
  const conn = useConn();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const openTab = useApp((s) => s.openTab);
  const { data: d } = useQuery({ queryKey: ['quality-test', conn.id, test.id, test.lastRunAt], queryFn: () => api.get<Detail>(`/quality/${conn.id}/tests/${test.id}`) });
  const [cron, setCron] = useState(test.schedule ?? '');
  useEffect(() => setCron(test.schedule ?? ''), [test.id, test.schedule]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['quality', conn.id] }); };
  const patch = useMutation({ mutationFn: (b: Record<string, unknown>) => api.patch(`/quality/${conn.id}/tests/${test.id}`, b), onSuccess: refresh, onError: (e) => toastError(e, 'Not saved') });
  const run = useMutation({
    mutationFn: () => api.post<{ state: string; failing: number | null; ms: number; error?: string }>(`/quality/${conn.id}/tests/${test.id}/run`),
    onSuccess: (r) => { toast(r.state === 'pass' ? 'Passes' : r.state === 'error' ? 'The test errored' : `${num(r.failing)} offending rows`, r.error ?? `${fmtMs(r.ms)} · read-only, audited`, r.state === 'pass' ? 'success' : 'error'); refresh(); },
    onError: (e) => toastError(e),
  });
  const del = useMutation({ mutationFn: () => api.del(`/quality/${conn.id}/tests/${test.id}`), onSuccess: () => { onClose(); refresh(); }, onError: (e) => toastError(e) });
  const last = d?.last;
  const opts: Array<[keyof Test['options'], string, string]> = [
    ['runOnSchedule', 'Run on schedule', test.schedule ? `cron ${test.schedule} · runs as the test's author` : 'Set a cron schedule below.'],
    ['notify', 'Notify Admins on failure', 'In-app notification; integrations also receive dq.failed.'],
    ['blockExport', 'Block scheduled exports while failing', 'A red test holds this connection\'s scheduled exports.'],
  ];

  return (
    <div style={{ width: 370, flex: 'none', background: 'var(--bg-raised)', borderLeft: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{test.name}</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} aria-label="Close" className="hov-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>✕</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', padding: '9px 10px' }}>
          <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap' }}>{test.sql}</pre>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={label}>Rule</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Fails when</span>
            <span style={{ fontFamily: MONO, fontSize: 12, padding: '2px 7px', border: '1px solid var(--border-strong)', borderRadius: 3 }}>{test.rule}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant="primary" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'running…' : '▷ Run now'}</Button>
          <Button size="sm" onClick={() => openTab('query', test.name.slice(0, 24), { sql: test.sql + ';' }, { unique: false })}>Open in a query tab</Button>
        </div>
        {last?.state === 'error' ? <Callout kind="error" title="The last run errored">{last.error}</Callout> : null}
        {last && last.state === 'fail' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={label}>Offending rows · first {Math.min(4, last.sample?.length ?? 0)} of {num(last.failing)}</div>
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
              {last.columns?.length ? (
                <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', height: 22, fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>({last.columns.join(', ')})</div>
              ) : null}
              {(last.sample ?? []).map((row, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '0 10px', height: 24, borderTop: '1px solid var(--border-subtle)', background: 'color-mix(in oklab, var(--state-error) 7%, transparent)' }}>
                  <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>({row.map(fmtCell).join(', ')})</span>
                </div>
              ))}
              {!last.columns?.length ? <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)' }}>Rows not stored: every column is classified secret.</div> : null}
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Stored masked, without secret columns, at most 4 rows. Opening the query shows what your access allows.</span>
            <Button size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => { openTab('query', 'failing: ' + test.name.slice(0, 18), { sql: test.sql + ';' }, { unique: false }); toast('Query tab opened', 'The failing rows query, not run. Look before you fix.', 'info'); }}>Open all in a query tab</Button>
          </div>
        ) : null}
        {canEdit ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: 10, border: '1px solid var(--border-subtle)', borderRadius: 3 }}>
              {opts.map(([k, l, hint]) => {
                const on = k === 'runOnSchedule' ? test.options.runOnSchedule !== false && !!test.schedule : !!test.options[k];
                return (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}><span style={{ fontSize: 13, lineHeight: '18px' }}>{l}</span><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</span></div>
                    <Toggle on={on} disabled={k === 'runOnSchedule' && !test.schedule} onChange={(v) => patch.mutate({ options: { [k]: v } })} />
                  </div>
                );
              })}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <TextInput mono value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 6 * * *" aria-label="Cron schedule" style={{ flex: 1, height: 24, fontSize: 12 }} />
                <Button size="sm" disabled={cron === (test.schedule ?? '')} onClick={() => patch.mutate({ schedule: cron.trim() || null, options: { runOnSchedule: !!cron.trim() } })}>{cron.trim() ? 'Schedule' : 'Unschedule'}</Button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Severity</span>
              <Seg options={['info', 'warn', 'critical'] as const} value={test.severity} onChange={(v) => patch.mutate({ severity: v })} />
              <span style={{ flex: 1 }} />
              <Button size="sm" variant="danger-ghost" onClick={() => del.mutate()}>Delete</Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

interface CatalogCols { columns: Array<{ schema: string; table: string; column: string; type: string }> }

function NewTest({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const conn = useConn();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const tree = useTree();
  const { data: cat } = useQuery({ queryKey: ['catalog', conn.id], queryFn: () => api.get<CatalogCols>(`/catalog/${conn.id}`) });
  const tables = (tree.data?.schemas ?? []).flatMap((s) => s.tables.map((t) => `${s.name}.${t.name}`));
  const [kind, setKind] = useState<Kind>('not_null');
  const [target, setTarget] = useState('');
  const [column, setColumn] = useState('');
  const [name, setName] = useState('');
  const [values, setValues] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [minRows, setMinRows] = useState('1');
  const [ref, setRef] = useState('');
  const [refCol, setRefCol] = useState('');
  const [sql, setSql] = useState('');
  const [schedule, setSchedule] = useState('');
  const [severity, setSeverity] = useState<'info' | 'warn' | 'critical'>('warn');
  const [schema, table] = target ? target.split('.') : ['public', ''];
  const colsOf = (t: string) => (cat?.columns ?? []).filter((c) => `${c.schema}.${c.table}` === t);
  const [rs, rt] = ref ? ref.split('.') : ['', ''];
  const body = {
    name: name || `${table || 'table'}${column ? '.' + column : ''} ${KIND_LABEL[kind]}`, kind, schema, table, column: column || null, severity,
    schedule: schedule.trim() || null, options: { runOnSchedule: !!schedule.trim() },
    config: {
      ...(kind === 'accepted_values' ? { values: values.split(',').map((v) => v.trim()).filter(Boolean) } : {}),
      ...(kind === 'freshness' ? { maxAgeMinutes: Number(minutes) || 60 } : {}),
      ...(kind === 'row_count_min' ? { minRows: Number(minRows) || 0 } : {}),
      ...(kind === 'referential' ? { refSchema: rs, refTable: rt, refColumn: refCol } : {}),
      ...(kind === 'custom' ? { sql } : {}),
    },
  };
  const ready = !!table && (kind === 'custom' ? !!sql.trim() : kind === 'row_count_min' || !!column);
  const preview = useQuery({
    queryKey: ['dq-preview', conn.id, JSON.stringify(body)],
    queryFn: () => api.post<{ sql?: string; rule?: string; error?: string }>(`/quality/${conn.id}/preview`, body),
    enabled: ready,
  });
  const create = useMutation({
    mutationFn: () => api.post<Test>(`/quality/${conn.id}/tests`, body),
    onSuccess: (t) => { toast('Test created', 'Run it to get a first result.', 'success'); void qc.invalidateQueries({ queryKey: ['quality', conn.id] }); onCreated(t.id); },
    onError: (e) => toastError(e, 'Test not created'),
  });
  const sel: React.CSSProperties = { height: 28, border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', fontSize: 13, padding: '0 6px', minWidth: 0 };
  const row = (l: string, c: React.ReactNode) => (
    <label style={{ display: 'grid', gridTemplateColumns: '110px 1fr', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-secondary)' }}><span>{l}</span>{c}</label>
  );

  return (
    <Modal title="New quality test" onClose={onClose} width={600}
      footer={<><span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>Runs read-only and audited. Passing means the query returns zero rows.</span>
        <Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready || !!preview.data?.error || create.isPending} onClick={() => create.mutate()}>Create test</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {row('Kind', <select style={sel} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>)}
        {row('Table', <select style={sel} value={target} onChange={(e) => { setTarget(e.target.value); setColumn(''); }}><option value="">— pick a table —</option>{tables.map((t) => <option key={t}>{t}</option>)}</select>)}
        {kind !== 'custom' && kind !== 'row_count_min' ? row('Column', <select style={sel} value={column} onChange={(e) => setColumn(e.target.value)}><option value="">— pick a column —</option>{colsOf(target).map((c) => <option key={c.column} value={c.column}>{c.column} · {c.type}</option>)}</select>) : null}
        {kind === 'accepted_values' ? row('Accepted', <TextInput mono value={values} onChange={(e) => setValues(e.target.value)} placeholder="paid, shipped, refunded" />) : null}
        {kind === 'freshness' ? row('Max age (min)', <TextInput mono value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} />) : null}
        {kind === 'row_count_min' ? row('At least rows', <TextInput mono value={minRows} onChange={(e) => setMinRows(e.target.value.replace(/\D/g, ''))} />) : null}
        {kind === 'referential' ? row('References', <div style={{ display: 'flex', gap: 6 }}>
          <select style={{ ...sel, flex: 1 }} value={ref} onChange={(e) => { setRef(e.target.value); setRefCol(''); }}><option value="">— table —</option>{tables.map((t) => <option key={t}>{t}</option>)}</select>
          <select style={{ ...sel, flex: 1 }} value={refCol} onChange={(e) => setRefCol(e.target.value)}><option value="">— column —</option>{colsOf(ref).map((c) => <option key={c.column}>{c.column}</option>)}</select>
        </div>) : null}
        {kind === 'custom' ? (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
            One SELECT that returns the offending rows
            <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={5} spellCheck={false} placeholder="select id, total from orders where total < 0"
              style={{ fontFamily: MONO, fontSize: 12, border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', padding: 8, resize: 'vertical' }} />
          </label>
        ) : null}
        {row('Name', <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={body.name} />)}
        {row('Severity', <Seg options={['info', 'warn', 'critical'] as const} value={severity} onChange={setSeverity} />)}
        {row('Schedule', <TextInput mono value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="cron, e.g. 0 6 * * * (optional)" />)}
        {ready ? (
          preview.data?.error ? <Callout kind="error" title="Not a valid test">{preview.data.error}</Callout> : preview.data?.sql ? (
            <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap' }}>{preview.data.sql}</pre>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Fails when <span style={{ fontFamily: MONO }}>{preview.data.rule}</span></span>
            </div>
          ) : null
        ) : null}
      </div>
    </Modal>
  );
}
