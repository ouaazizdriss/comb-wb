import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryResult } from '@comb/shared';
import type { Tab } from '../lib/store.ts';
import { useApp, useConn, toastError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { withConfirm } from '../lib/confirm.ts';
import { ago, ms as fmtMs, num } from '../lib/format.ts';
import { Button, Seg, Toggle, Modal, TextInput, Label, Loading, ErrorBox, Empty, MONO, COND } from '../ui/index.tsx';

/** Query library: saved, versioned, shareable queries with bound parameters. */

interface LibItem {
  id: string; name: string; description: string; tags: string[]; owner: { id: string; label: string };
  visibility: 'private' | 'shared' | 'readonly'; shared: boolean; allowSchedule: boolean; connectionId: string | null;
  version: number; runs: number; avgMs: number | null; lastRunAt: string | null; lastRunBy: string | null;
  mine: boolean; canEdit: boolean; params: string[]; updatedAt: string;
}
interface LibDetail extends LibItem {
  sql: string;
  paramDefs: Record<string, { type: 'text' | 'number'; default?: string }>;
  versions: Array<{ n: number; note: string; author: string; at: string }>;
}
interface Diff { from: number; to: number; added: number; removed: number; lines: Array<{ op: ' ' | '+' | '-'; text: string }> }

const FILTERS = ['All', 'Mine', 'Shared'] as const;
type Filter = (typeof FILTERS)[number];

const sectionLabel: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };
const KW = /^(select|from|where|group|order|left|right|inner|join|and|or|with|having|limit|union|insert|update|delete|set|values|on)\b/i;

function SqlLines({ text }: { text: string }) {
  return (
    <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', overflow: 'auto', padding: '6px 0' }}>
      {text.split('\n').map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, padding: '0 12px' }}>
          <span style={{ fontFamily: MONO, fontSize: 12, lineHeight: '19px', color: 'var(--text-muted)', width: 20, textAlign: 'right', flex: 'none', userSelect: 'none' }}>{i + 1}</span>
          <span style={{ fontFamily: MONO, fontSize: 12, lineHeight: '19px', whiteSpace: 'pre', color: l.trim().startsWith('--') ? 'var(--text-muted)' : KW.test(l.trim()) ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{l || ' '}</span>
        </div>
      ))}
    </div>
  );
}

/** Rough client-side placeholder detection for the editor preview; the server decides with the real scanner. */
function guessParams(sql: string): string[] {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set<string>();
  for (const m of stripped.matchAll(/(^|[^:]):([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[2]);
  return [...out];
}

function latestQuerySql(): string {
  const { tabs, active } = useApp.getState();
  const act = tabs.find((t) => t.id === active && t.kind === 'query');
  const any = act ?? [...tabs].reverse().find((t) => t.kind === 'query' && t.params?.sql);
  return String(any?.params?.sql ?? '');
}

export default function LibraryScreen({ tab }: { tab: Tab }) {
  const conn = useConn();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const updateTab = useApp((s) => s.updateTab);
  const openTab = useApp((s) => s.openTab);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  const [editor, setEditor] = useState<null | { mode: 'new' | 'edit'; init: Partial<LibDetail> }>(null);
  const sel: string | undefined = tab.params?.sel;

  const list = useQuery({
    queryKey: ['library', search, filter],
    queryFn: () => api.get<LibItem[]>(`/library?limit=500&filter=${filter}${search ? '&q=' + encodeURIComponent(search) : ''}`),
  });
  const items = list.data ?? [];
  const selId = sel && (items.some((x) => x.id === sel) || !list.data) ? sel : items[0]?.id;
  const detail = useQuery({ queryKey: ['library-item', selId], queryFn: () => api.get<LibDetail>(`/library/${selId}`), enabled: !!selId, retry: false });

  const select = (id: string) => updateTab(tab.id, { params: { sel: id } });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['library'] });
    qc.invalidateQueries({ queryKey: ['library-item'] });
    qc.invalidateQueries({ queryKey: ['library-side'] });
  };

  const shared = items.filter((x) => x.shared).length;
  const folders = new Set(items.flatMap((x) => x.tags)).size;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflowX: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 3, width: 200, flex: 'none' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search the library" aria-label="Search the library" style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12 }} />
        </div>
        <Seg options={FILTERS} value={filter} onChange={setFilter} />
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none' }}>
          {items.length} {items.length === 1 ? 'query' : 'queries'} · {folders} {folders === 1 ? 'tag' : 'tags'} · {shared} shared
        </span>
        <span style={{ flex: 1, minWidth: 8 }} />
        <Button variant="primary" size="sm" onClick={() => setEditor({ mode: 'new', init: { sql: latestQuerySql(), connectionId: null } })}>+ Save current query</Button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ width: 290, flex: 'none', borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflow: 'auto' }}>
          {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={() => list.refetch()} /> : null}
          {items.map((x) => (
            <div key={x.id} className="row-hover" onClick={() => select(x.id)}
              style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)', background: selId === x.id ? 'var(--bg-selected)' : 'transparent' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 11, width: 11, flex: 'none' }}>⌗</span>
                <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name}</span>
                <span style={{ flex: 1 }} />
                {x.shared ? <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--state-info)' }}>{x.visibility === 'readonly' ? 'LOCKED' : 'SHARED'}</span> : null}
              </div>
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {[x.tags.join('/') || 'untagged', x.mine ? 'you' : x.owner.label, `ran ${num(x.runs)}×`].join(' · ')}
              </span>
            </div>
          ))}
          {list.data && !items.length ? (
            <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              {search || filter !== 'All' ? 'No saved query matches.' : 'Nothing saved yet. Save a query from a query tab, or with + Save current query.'}
            </div>
          ) : null}
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {!selId ? (
            <Empty title="Query library" body="Saved queries are versioned, can take :parameters, and can be shared with the workspace or scheduled." />
          ) : detail.isLoading ? <Loading /> : detail.error ? <ErrorBox error={detail.error} /> : detail.data ? (
            <Detail key={detail.data.id + ':' + detail.data.version} q={detail.data} connId={conn.id}
              onEdit={() => setEditor({ mode: 'edit', init: detail.data! })}
              onChanged={refresh}
              onDeleted={() => { updateTab(tab.id, { params: { sel: undefined } }); refresh(); }}
              onForked={(id) => { select(id); refresh(); }}
              onOpen={(sql) => { openTab('query', detail.data!.name.slice(0, 24), { sql }, { unique: false }); toast('Opened ' + detail.data!.name, 'Parameters carried over. Nothing ran yet.', 'info'); }}
              onSchedule={(params) => {
                openTab('jobs', 'Jobs', { draft: { libraryId: detail.data!.id, libraryName: detail.data!.name, name: detail.data!.name, params, nonce: Date.now() } });
                toast('Pick a cadence', 'Comb validates the cron and previews the next five runs before it saves.', 'info');
              }} />
          ) : null}
        </div>
      </div>
      {editor ? <Editor mode={editor.mode} init={editor.init} onClose={() => setEditor(null)} onSaved={(id) => { setEditor(null); select(id); refresh(); }} /> : null}
    </div>
  );
}

function Detail({ q, connId, onEdit, onChanged, onDeleted, onForked, onOpen, onSchedule }: {
  q: LibDetail; connId: string; onEdit: () => void; onChanged: () => void; onDeleted: () => void; onForked: (id: string) => void;
  onOpen: (sql: string) => void; onSchedule: (params: Record<string, string>) => void;
}) {
  const toast = useApp((s) => s.toast);
  const me = useApp((s) => s.me);
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(q.params.map((p) => [p, q.paramDefs[p]?.default ?? ''])));
  const [result, setResult] = useState<QueryResult | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);

  const run = useMutation({
    mutationFn: () => withConfirm((confirm) => api.post<QueryResult & { approvalId?: number }>(`/library/${q.id}/run`, { connId, params: vals, confirm, maxRows: 500 })),
    onSuccess: (r) => {
      setRunErr(null);
      if (!r) return;
      if (r.approvalId) { toast('Sent for approval', `ap-${r.approvalId}: an approver must run it.`, 'info'); return; }
      setResult(r);
      onChanged();
    },
    onError: (e) => { setResult(null); setRunErr(e instanceof Error ? e.message : String(e)); },
  });
  const bind = async (): Promise<string | null> => {
    try {
      return (await api.post<{ sql: string }>(`/library/${q.id}/bind`, { params: vals })).sql;
    } catch (e) {
      toastError(e, 'Cannot bind the parameters');
      return null;
    }
  };
  const share = async (patch: { visibility?: LibItem['visibility']; allowSchedule?: boolean }) => {
    try {
      await api.patch(`/library/${q.id}/sharing`, patch);
      onChanged();
    } catch (e) { toastError(e); }
  };
  const showDiff = async (n: number) => {
    try {
      setDiff(await api.get<Diff>(`/library/${q.id}/diff?from=${n}&to=${q.version}`));
    } catch (e) { toastError(e); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${q.name}" and its ${q.versions.length} versions?`)) return;
    try {
      await api.del(`/library/${q.id}`);
      toast('Deleted ' + q.name);
      onDeleted();
    } catch (e) { toastError(e); }
  };
  const fork = async () => {
    try {
      const r = await api.post<{ id: string }>(`/library/${q.id}/fork`, {});
      toast('Forked', 'A private copy you can edit.', 'success');
      onForked(r.id);
    } catch (e) { toastError(e); }
  };
  const owner = q.mine;
  const canDelete = owner || me?.role === 'Admin' || me?.role === 'Owner';
  const shareOpts: Array<{ label: string; hint: string; on: boolean; set: (v: boolean) => void }> = [
    { label: 'Shared with the workspace', hint: 'Anyone with access to the connection can run it.', on: q.visibility !== 'private',
      set: (v) => share({ visibility: v ? 'shared' : 'private' }) },
    { label: 'Allow scheduling', hint: 'Others can attach a schedule without copying it.', on: q.allowSchedule, set: (v) => share({ allowSchedule: v }) },
    { label: 'Lock the SQL', hint: 'Only the owner can edit; others fork.', on: q.visibility === 'readonly',
      set: (v) => share({ visibility: v ? 'readonly' : q.visibility === 'private' ? 'private' : 'shared' }) },
  ];

  return (
    <div style={{ padding: '16px 18px 50px', maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ fontSize: 18, lineHeight: '24px', fontWeight: 600 }}>{q.name}</div>
          <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--text-secondary)' }}>{q.description || <span style={{ color: 'var(--text-muted)' }}>No description.</span>}</div>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={async () => { const s = await bind(); if (s !== null) onOpen(s); }}>Open in a tab</Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? 'Running…' : 'Run'}</Button>
          <Button onClick={() => onSchedule(vals)} disabled={!owner && !q.allowSchedule} title={!owner && !q.allowSchedule ? 'The owner does not allow scheduling; fork it first' : undefined}>Schedule…</Button>
          {q.canEdit ? <Button onClick={onEdit}>Edit</Button> : <Button onClick={fork}>Fork</Button>}
          {canDelete ? <Button variant="danger-ghost" onClick={remove}>Delete</Button> : null}
        </div>
      </div>

      {q.params.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={sectionLabel}>Parameters</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {q.params.map((p) => (
              <label key={p} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
                <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>:{p}{q.paramDefs[p]?.type === 'number' ? <span style={{ color: 'var(--text-muted)' }}> · number</span> : null}</span>
                <input value={vals[p] ?? ''} onChange={(e) => setVals({ ...vals, [p]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && run.mutate()}
                  style={{ height: 26, padding: '0 9px', background: 'var(--bg-raised)', border: '1px solid var(--border-strong)', borderRadius: 3, fontFamily: MONO, fontSize: 12 }} />
              </label>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Parameters are bound, not interpolated — a saved query cannot be turned into a different statement by its inputs.</div>
        </div>
      ) : null}

      <SqlLines text={q.sql} />

      {runErr ? <div style={{ padding: '8px 11px', border: '1px solid var(--state-error)', borderLeft: '3px solid var(--state-error)', borderRadius: 3, fontSize: 12, fontFamily: MONO, color: 'var(--text-primary)' }}>{runErr}</div> : null}
      {result ? <ResultPreview r={result} /> : null}

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={sectionLabel}>Versions</div>
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
            {q.versions.map((v, i) => (
              <div key={v.n} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', height: 28, borderTop: i ? '1px solid var(--border-subtle)' : 'none', background: i === 0 ? 'var(--bg-base)' : 'transparent' }}>
                <span style={{ fontFamily: MONO, fontSize: 12, width: 34, flex: 'none', color: 'var(--text-muted)' }}>v{v.n}</span>
                <span title={new Date(v.at).toLocaleString()} style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.note || '—'}</span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{v.author.split('@')[0]}</span>
                {i > 0 ? <button onClick={() => showDiff(v.n)} style={{ fontSize: 11, color: 'var(--state-info)', whiteSpace: 'nowrap' }}>diff</button> : <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 18 }}>now</span>}
              </div>
            ))}
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Versions are immutable; every save adds one.</span>
        </div>
        <div style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={sectionLabel}>Sharing</div>
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, padding: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
            {shareOpts.map((s) => (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontSize: 13, lineHeight: '18px' }}>{s.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.hint}</span>
                </div>
                <Toggle on={s.on} onChange={s.set} disabled={!owner} title={owner ? undefined : `Only ${q.owner.label} can change sharing`} />
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
              <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {q.runs ? `ran ${num(q.runs)}× · avg ${fmtMs(q.avgMs)} · last run ${ago(q.lastRunAt)} by ${(q.lastRunBy ?? '').split('@')[0]}` : 'never run'}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>owner {q.mine ? 'you' : q.owner.label}</span>
            </div>
          </div>
        </div>
      </div>
      {diff ? (
        <Modal title={`Diff v${diff.from} → v${diff.to}`} onClose={() => setDiff(null)} width={720} footer={<><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{diff.added} added · {diff.removed} removed. Restoring an old version means saving it again as a new one.</span><span className="spacer" /><Button onClick={() => setDiff(null)}>Close</Button></>}>
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-inset)', padding: '6px 0', overflow: 'auto' }}>
            {diff.lines.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '0 10px', fontFamily: MONO, fontSize: 12, lineHeight: '19px', whiteSpace: 'pre',
                background: l.op === '+' ? 'color-mix(in oklab, var(--state-success) 10%, transparent)' : l.op === '-' ? 'color-mix(in oklab, var(--danger) 10%, transparent)' : 'transparent' }}>
                <span style={{ width: 8, flex: 'none', color: l.op === '+' ? 'var(--state-success)' : l.op === '-' ? 'var(--danger)' : 'var(--text-muted)' }}>{l.op}</span>
                <span>{l.text || ' '}</span>
              </div>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function ResultPreview({ r }: { r: QueryResult }) {
  if (!r.columns.length) {
    return <div style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>{r.statements.map((s) => `${s.command}${s.rowCount !== null ? ' ' + s.rowCount : ''}`).join(' · ')} · {fmtMs(r.ms)}</div>;
  }
  const rows = r.rows.slice(0, 100);
  const cell = (v: unknown) => (v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Label>Result</Label>
        <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>{num(r.rows.length)} rows{r.truncated ? ' (truncated)' : ''} · {fmtMs(r.ms)}{r.rows.length > 100 ? ' · first 100 shown' : ''}</span>
      </div>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'auto', maxHeight: 320 }}>
        <table style={{ borderCollapse: 'collapse', fontFamily: MONO, fontSize: 12, width: '100%' }}>
          <thead>
            <tr>{r.columns.map((c) => <th key={c.name} style={{ position: 'sticky', top: 0, background: 'var(--bg-raised)', textAlign: 'left', padding: '5px 10px', borderBottom: '1px solid var(--border-subtle)', fontWeight: 500, whiteSpace: 'nowrap' }}>{c.name}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>{row.map((v, j) => <td key={j} style={{ padding: '3px 10px', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap', color: v === null ? 'var(--text-muted)' : 'var(--text-primary)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>{cell(v)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Editor({ mode, init, onClose, onSaved }: { mode: 'new' | 'edit'; init: Partial<LibDetail>; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useApp((s) => s.toast);
  const firstComment = /^\s*--\s*(.+)$/m.exec(init.sql ?? '')?.[1]?.trim();
  const [name, setName] = useState(init.name ?? firstComment?.slice(0, 80) ?? '');
  const [description, setDescription] = useState(init.description ?? '');
  const [tags, setTags] = useState((init.tags ?? []).join(', '));
  const [sql, setSql] = useState(init.sql ?? '');
  const [note, setNote] = useState('');
  const [defs, setDefs] = useState<Record<string, { type: 'text' | 'number'; default?: string }>>(init.paramDefs ?? {});
  const [busy, setBusy] = useState(false);
  const params = useMemo(() => guessParams(sql), [sql]);
  useEffect(() => {
    setDefs((d) => Object.fromEntries(params.map((p) => [p, d[p] ?? { type: 'text' }])));
  }, [params]);
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: name.trim(), description, sql, params: defs, tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        note: note.trim() || (mode === 'new' ? 'first version' : 'edited'),
      };
      const r = mode === 'new' ? await api.post<{ id: string }>('/library', body) : await api.put<{ id: string }>(`/library/${init.id}`, body);
      toast(mode === 'new' ? 'Saved to the library' : 'Saved a new version', mode === 'new' ? 'Private until you share it.' : undefined, 'success');
      onSaved(r.id);
    } catch (e) {
      toastError(e, 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={mode === 'new' ? 'Save a query' : `Edit ${init.name}`} onClose={onClose} width={680}
      footer={<><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{mode === 'new' ? 'Private until you share it.' : 'Saving creates a new version.'}</span><span className="spacer" /><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !name.trim() || !sql.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Name"><TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="MRR by month" /></Field>
        <Field label="Description"><TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="what it answers, in one line" /></Field>
        <Field label="Tags (comma separated)"><TextInput value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Finance, Revenue" /></Field>
        <Field label="SQL — use :name for parameters">
          <textarea value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} rows={10}
            style={{ fontFamily: MONO, fontSize: 12, lineHeight: '19px', padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-inset)', resize: 'vertical', minHeight: 160 }} />
        </Field>
        {params.length ? (
          <Field label="Parameters">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {params.map((p) => (
                <div key={p} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontFamily: MONO, fontSize: 12, width: 140 }}>:{p}</span>
                  <Seg options={['text', 'number'] as const} value={defs[p]?.type ?? 'text'} onChange={(t) => setDefs({ ...defs, [p]: { ...defs[p], type: t } })} />
                  <TextInput mono value={defs[p]?.default ?? ''} onChange={(e) => setDefs({ ...defs, [p]: { type: defs[p]?.type ?? 'text', default: e.target.value || undefined } })} placeholder="default" style={{ flex: 1, height: 24 }} />
                </div>
              ))}
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Text values become escaped literals; numbers must be numeric literals. Either way the statement cannot change.</span>
            </div>
          </Field>
        ) : null}
        <Field label="Version note"><TextInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={mode === 'new' ? 'first version' : 'what changed'} /></Field>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <Label>{label}</Label>
      {children}
    </label>
  );
}

