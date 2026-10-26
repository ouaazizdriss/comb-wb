import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { typeFamily } from '@comb/shared';
import type { Tab } from '../lib/store.ts';
import { useApp, useConn, toastError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { ago, num } from '../lib/format.ts';
import { Button, Chip, ErrorBox, Loading, MONO, COND, TYPE_COLOR, Seg } from '../ui/index.tsx';

/*
 * Data catalog: every column of the open connection, merged with Comb's classification,
 * masking, owner and description. PII scan candidates are flagged for a human to confirm.
 */

const KL = ['UNCLASSIFIED', 'INTERNAL', 'FINANCIAL', 'PII', 'SECRET'] as const;
const MK = ['none', 'partial', 'full'] as const;
type Klass = (typeof KL)[number];
type Mask = (typeof MK)[number];
const FILTERS = ['All', 'PII', 'Unclassified', 'Masked'] as const;
type Filter = (typeof FILTERS)[number];

export const klassColor = (k: string) =>
  ({ PII: 'var(--type-identifier)', SECRET: 'var(--danger)', FINANCIAL: 'var(--type-structured)', INTERNAL: 'var(--state-info)', UNCLASSIFIED: 'var(--text-muted)' } as Record<string, string>)[k];
const maskColor = (m: string) => (m === 'full' ? 'var(--state-success)' : m === 'partial' ? 'var(--state-running)' : 'var(--text-muted)');

interface Candidate { id: number; suggested: 'PII' | 'SECRET'; hint: string | null; matches: Record<string, number>; sampled: number }
interface Col {
  schema: string; table: string; column: string; type: string; comment: string | null; classification: Klass; masking: Mask;
  ownerId: string | null; description: string; tags: string[]; candidate: Candidate | null; queries30d: number; views: number;
}
interface CatalogData {
  columns: Col[]; tables: number; members: Array<{ id: string; name: string; email: string }>;
  lastScan: { started_at: string; finished_at: string | null; status: string; new_candidates: number } | null;
  can: { classify: boolean; mask: boolean; edit: boolean; unmasked: boolean };
}
interface Detail {
  type: string; family: string; classification: Klass; masking: Mask;
  profile: { n?: number; nonnull?: number; min?: string; max?: string; avglen?: number; maxlen?: number; distinct: number | null; nullFrac: number | null; hasStats: boolean; error?: string };
  hist: Array<{ freq: number; value: string | null }>; valuesHidden: boolean; minMaxHidden: boolean;
  lineage: Array<{ dir: 'in' | 'out' | 'self'; name: string; kind: string }>;
  access: Array<{ who: string; n: number }>; retention: string;
}

const keyOf = (c: Pick<Col, 'schema' | 'table' | 'column'>) => `${c.schema}.${c.table}.${c.column}`;
const nameOf = (c: Pick<Col, 'schema' | 'table' | 'column'>) => (c.schema === 'public' ? `${c.table}.${c.column}` : keyOf(c));
const T = '230px 120px 132px 104px 130px minmax(160px,1fr) 150px';
const cell: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', overflow: 'hidden', minWidth: 0 };
const chipSelect = (color: string, strong: boolean): React.CSSProperties => ({
  height: 20, padding: '0 6px', border: '1px solid ' + (strong ? color : 'var(--border-subtle)'), borderRadius: 3, fontFamily: COND, fontSize: 11, fontWeight: 600,
  letterSpacing: '0.06em', color, background: 'transparent', appearance: 'none', cursor: 'pointer', textTransform: 'uppercase',
});
const label: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };

export default function CatalogScreen({ tab }: { tab: Tab }) {
  const conn = useConn();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const updateTab = useApp((s) => s.updateTab);
  const [search, setSearch] = useState('');
  const filter: Filter = tab.params?.filter ?? 'All';
  const sel: string | null = tab.params?.sel ?? null;
  const key = ['catalog', conn.id];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.get<CatalogData>(`/catalog/${conn.id}`) });

  const patch = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.patch(`/catalog/${conn.id}/column`, b),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['catalog-col', conn.id] }); },
    onError: (e) => toastError(e, 'Catalog not updated'),
  });
  const scan = useMutation({
    mutationFn: () => api.post<{ columnsSeen: number; columnsSampled: number; newCandidates: number; candidates: number; ms: number }>(`/catalog/${conn.id}/scan`),
    onSuccess: (r) => {
      toast(r.newCandidates ? `${r.newCandidates} new PII candidate${r.newCandidates === 1 ? '' : 's'}` : 'PII scan finished',
        `${num(r.columnsSeen)} columns by name, ${num(r.columnsSampled)} sampled (200 values each, read-only). Only match counts are kept; values never leave the server.`, 'info');
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toastError(e, 'PII scan failed'),
  });

  const cols = data?.columns ?? [];
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cols.filter((c) => (filter === 'All' || (filter === 'PII' ? c.classification === 'PII' || c.classification === 'SECRET' || !!c.candidate
      : filter === 'Unclassified' ? c.classification === 'UNCLASSIFIED' : c.masking !== 'none'))
      && (!q || `${keyOf(c)} ${c.classification} ${c.description} ${c.tags.join(' ')} ${data?.members.find((m) => m.id === c.ownerId)?.name ?? ''}`.toLowerCase().includes(q)));
  }, [cols, filter, search, data]);

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={() => void refetch()} />;
  const d = data!;
  const pii = cols.filter((c) => c.classification === 'PII').length;
  const secret = cols.filter((c) => c.classification === 'SECRET').length;
  const uncl = cols.filter((c) => c.classification === 'UNCLASSIFIED').length;
  const cands = cols.filter((c) => c.candidate).length;
  const anyMasked = cols.some((c) => c.masking !== 'none');
  const current = sel ? cols.find((c) => keyOf(c) === sel) ?? null : null;
  const setParams = (p: Record<string, unknown>) => updateTab(tab.id, { params: p });

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflowX: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 3, width: 210, flex: 'none' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="column, table, owner, tag…" aria-label="Search the catalog" style={{ flex: 1, fontFamily: MONO, fontSize: 12, minWidth: 0 }} />
        </div>
        <Seg options={FILTERS} value={filter} onChange={(f) => setParams({ filter: f })} />
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none' }}>
          {shown.length} of {num(cols.length)} columns · {pii} PII · {secret} secret · {uncl} unclassified{cands ? ` · ${cands} to review` : ''}
        </span>
        <span style={{ flex: 1, minWidth: 8 }} />
        {d.lastScan ? <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', flex: 'none' }}>scanned {ago(d.lastScan.finished_at ?? d.lastScan.started_at)}</span> : null}
        {d.can.classify ? (
          <button className="hov" disabled={scan.isPending} onClick={() => scan.mutate()} style={{ height: 22, padding: '0 9px', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 12, whiteSpace: 'nowrap', flex: 'none' }}>
            {scan.isPending ? 'scanning…' : '⟳ Rescan for PII'}
          </button>
        ) : null}
      </div>
      {anyMasked ? (
        <div style={{ flex: 'none', padding: '5px 10px', fontSize: 11, lineHeight: '15px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)' }}>
          {d.can.unmasked ? 'You see raw values (admin access on this connection). ' : 'Masked values are masked for you in queries, the grid and exports. '}
          Masking follows direct column references, including through views and subqueries. Expressions such as <span style={{ fontFamily: MONO }}>lower(email)</span> lose the link to their column;
          they are masked only while they keep a masked column's name.
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: T, minWidth: 980, position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...label }}>
            {['Column', 'Type', 'Classification', 'Masking', 'Owner', 'Description', 'Used by'].map((h, i) => (
              <div key={h} style={{ padding: '5px 10px', borderRight: i < 6 ? '1px solid var(--border-subtle)' : 'none' }}>{h}</div>
            ))}
          </div>
          {shown.map((c) => {
            const k = keyOf(c);
            const owner = d.members.find((m) => m.id === c.ownerId);
            const stop = (e: React.SyntheticEvent) => e.stopPropagation();
            return (
              <div key={k} className="row-hover" onClick={() => setParams({ sel: k })}
                style={{ display: 'grid', gridTemplateColumns: T, minWidth: 980, height: 30, borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', background: sel === k ? 'var(--bg-selected)' : undefined }}>
                <div style={{ ...cell, gap: 7 }}>
                  <span style={{ width: 2, height: 13, flex: 'none', background: TYPE_COLOR[typeFamily(c.type)] }} />
                  <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(c)}</span>
                  {c.candidate ? <Chip color={klassColor(c.candidate.suggested)} style={{ fontSize: 10 }}>{c.candidate.suggested}?</Chip> : null}
                </div>
                <div style={{ ...cell, fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{c.type}</div>
                <div style={{ ...cell, padding: '0 8px' }}>
                  <select aria-label={`Classification of ${nameOf(c)}`} disabled={!d.can.classify || patch.isPending} value={c.classification} onClick={stop}
                    onChange={(e) => patch.mutate({ schema: c.schema, table: c.table, column: c.column, classification: e.target.value },
                      { onSuccess: () => toast(`${nameOf(c)} → ${e.target.value}`, e.target.value === 'SECRET' ? 'Masked in full below admin and never stored in quality samples.' : 'Classification recorded in the catalog and in the trail.', 'info') })}
                    style={chipSelect(klassColor(c.classification), true)}>
                    {KL.map((k2) => <option key={k2} value={k2}>{k2}</option>)}
                  </select>
                </div>
                <div style={{ ...cell, padding: '0 8px' }}>
                  <select aria-label={`Masking of ${nameOf(c)}`} disabled={!d.can.mask || patch.isPending} value={c.masking} onClick={stop}
                    onChange={(e) => patch.mutate({ schema: c.schema, table: c.table, column: c.column, masking: e.target.value },
                      { onSuccess: () => toast('Masking: ' + e.target.value, e.target.value === 'none' ? 'Raw values visible to anyone with read access.' : e.target.value === 'partial' ? 'Shown as a***@example.com or ***1234 below admin access.' : "Shown as '***' below admin access.", 'info') })}
                    style={chipSelect(maskColor(c.masking), c.masking !== 'none')}>
                    {MK.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div style={{ ...cell, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{owner ? owner.name || owner.email : '—'}</div>
                <div style={{ ...cell, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{c.description || (c.tags.length ? c.tags.map((t) => '#' + t).join(' ') : '')}</div>
                <div style={{ ...cell, borderRight: 'none', fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {c.queries30d} quer{c.queries30d === 1 ? 'y' : 'ies'}{c.views ? ` · ${c.views} view${c.views === 1 ? '' : 's'}` : ''}
                </div>
              </div>
            );
          })}
          {!shown.length ? (
            <div style={{ padding: '44px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: 24, lineHeight: '30px', fontWeight: 600, marginBottom: 6 }}>No columns match.</div>
              <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)' }}>The catalog covers {d.tables} tables and {num(cols.length)} columns in this connection.</div>
            </div>
          ) : null}
        </div>
        {current ? <DetailPanel col={current} data={d} onClose={() => setParams({ sel: null })} onPatch={(b) => patch.mutate({ schema: current.schema, table: current.table, column: current.column, ...b })} /> : null}
      </div>
    </div>
  );
}

function DetailPanel({ col, data, onClose, onPatch }: { col: Col; data: CatalogData; onClose: () => void; onPatch: (b: Record<string, unknown>) => void }) {
  const conn = useConn();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const qs = new URLSearchParams({ schema: col.schema, table: col.table, column: col.column }).toString();
  const { data: det, isLoading, error } = useQuery({ queryKey: ['catalog-col', conn.id, keyOf(col), col.masking, col.classification], queryFn: () => api.get<Detail>(`/catalog/${conn.id}/column?${qs}`) });
  const [desc, setDesc] = useState(col.description);
  const [tags, setTags] = useState(col.tags.join(', '));
  useEffect(() => { setDesc(col.description); setTags(col.tags.join(', ')); }, [col.schema, col.table, col.column, col.description, col.tags]);
  const decide = useMutation({
    mutationFn: (b: { action: 'confirm' | 'dismiss' }) => api.post(`/catalog/${conn.id}/candidates/${col.candidate!.id}`, b),
    onSuccess: (_r, b) => {
      toast(b.action === 'confirm' ? `${nameOf(col)} classified ${col.candidate!.suggested}` : 'Candidate dismissed', b.action === 'confirm' ? `Masking set to ${col.candidate!.suggested === 'SECRET' ? 'full' : 'partial'}; change it in the grid.` : 'The next scan keeps it dismissed.', 'info');
      void qc.invalidateQueries({ queryKey: ['catalog', conn.id] });
    },
    onError: (e) => toastError(e),
  });

  const p = det?.profile;
  const stats: Array<[string, string]> = p ? [
    ['distinct', p.distinct === null ? '—' : num(Math.round(p.distinct))],
    ['null', p.n ? ((100 * (p.n - (p.nonnull ?? 0))) / p.n).toFixed(1) + '%' : p.nullFrac !== null ? (p.nullFrac * 100).toFixed(1) + '%' : '—'],
    ...(det!.family === 'text' ? [['avg length', p.avglen === undefined || p.avglen === null ? '—' : String(p.avglen)], ['max length', p.maxlen === undefined || p.maxlen === null ? '—' : String(p.maxlen)]] as Array<[string, string]>
      : det!.family === 'numeric' || det!.family === 'temporal' ? [['min', det!.minMaxHidden ? 'masked' : p.min ?? '—'], ['max', det!.minMaxHidden ? 'masked' : p.max ?? '—']] as Array<[string, string]>
        : [['rows sampled', num(p.n ?? 0)], ['type', det!.type]] as Array<[string, string]>),
  ] : [];
  const maxAccess = Math.max(1, ...(det?.access ?? []).map((a) => a.n));
  const maxFreq = Math.max(0.0001, ...(det?.hist ?? []).map((h) => h.freq));
  const sectionLabel = (t: string) => <div style={label}>{t}</div>;

  return (
    <div style={{ width: 340, flex: 'none', background: 'var(--bg-raised)', borderLeft: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(col)}</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} aria-label="Close" className="hov-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>✕</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {col.candidate ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '9px 10px', border: `1px solid color-mix(in oklab, ${klassColor(col.candidate.suggested)} 55%, transparent)`, borderLeft: `3px solid ${klassColor(col.candidate.suggested)}`, borderRadius: 3 }}>
            <div style={{ fontSize: 12, lineHeight: '17px' }}>
              The PII scan thinks this is <b>{col.candidate.suggested}</b>
              {col.candidate.hint ? <> — the name looks like <span style={{ fontFamily: MONO }}>{col.candidate.hint}</span></> : null}
              {Object.entries(col.candidate.matches).filter(([, n]) => n > 0).map(([k, n]) => <span key={k}>{' · '}{n} of {col.candidate!.sampled} sampled values match <span style={{ fontFamily: MONO }}>{k}</span></span>)}.
            </div>
            {data.can.classify ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <Button size="sm" variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ action: 'confirm' })}>Confirm {col.candidate.suggested}</Button>
                <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ action: 'dismiss' })}>Not personal data</Button>
              </div>
            ) : <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>An Admin confirms or dismisses candidates.</span>}
          </div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sectionLabel('About')}
          <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: '6px 8px', alignItems: 'center', fontSize: 12 }}>
            <span style={{ color: 'var(--text-secondary)' }}>Type</span><span style={{ fontFamily: MONO }}>{col.type}</span>
            <span style={{ color: 'var(--text-secondary)' }}>Owner</span>
            <select aria-label="Owner" disabled={!data.can.edit} value={col.ownerId ?? ''} onChange={(e) => onPatch({ ownerId: e.target.value || null })}
              style={{ height: 24, border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', fontSize: 12, padding: '0 4px' }}>
              <option value="">— nobody —</option>
              {data.members.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
            </select>
            <span style={{ color: 'var(--text-secondary)', alignSelf: 'start', paddingTop: 4 }}>Description</span>
            <textarea aria-label="Description" disabled={!data.can.edit} value={desc} rows={2} maxLength={500} onChange={(e) => setDesc(e.target.value)}
              onBlur={() => desc !== col.description && onPatch({ description: desc })}
              placeholder={col.comment ?? 'what this column holds'}
              style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', fontSize: 12, padding: '4px 6px', resize: 'vertical' }} />
            <span style={{ color: 'var(--text-secondary)' }}>Tags</span>
            <input aria-label="Tags" disabled={!data.can.edit} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma separated"
              onBlur={() => { const next = tags.split(',').map((t) => t.trim()).filter(Boolean); if (next.join(',') !== col.tags.join(',')) onPatch({ tags: next }); }}
              style={{ height: 24, border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', fontSize: 12, padding: '0 6px', fontFamily: MONO }} />
          </div>
        </div>

        {isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : det ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sectionLabel('Profile · sampled 10k rows')}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
                {stats.map(([l, v]) => (
                  <div key={l} style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '7px 9px', border: '1px solid var(--border-subtle)', borderRadius: 3, minWidth: 0 }}>
                    <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v}>{v}</span>
                    <span style={label}>{l}</span>
                  </div>
                ))}
              </div>
              {det.hist.length ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 44, padding: 8, border: '1px solid var(--border-subtle)', borderRadius: 3 }}>
                    {det.hist.map((h, i) => (
                      <span key={i} title={`${h.value === null ? 'value ' + (i + 1) : h.value} · ${(h.freq * 100).toFixed(1)}%`}
                        style={{ flex: 1, height: Math.max(2, Math.round((h.freq / maxFreq) * 28)), background: 'var(--border-strong)' }} />
                    ))}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Most common values from pg_stats{det.valuesHidden ? '; values hidden because the column is masked or secret.' : '. Hover a bar for its value.'}
                  </span>
                </>
              ) : (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{det.profile.hasStats ? 'No value repeats often enough for a histogram.' : 'No statistics yet — ANALYZE this table to get distinct counts and a histogram.'}</span>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sectionLabel('Lineage')}
              {det.lineage.map((l, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 9px', height: 24, border: '1px solid ' + (l.dir === 'self' ? 'var(--border-strong)' : 'var(--border-subtle)'), borderRadius: 3, background: l.dir === 'self' ? 'var(--bg-base)' : 'transparent' }}>
                  <span style={{ width: 10, flex: 'none', fontFamily: MONO, fontSize: 12, color: l.dir === 'self' ? 'var(--text-primary)' : 'var(--text-muted)' }}>{l.dir === 'self' ? '·' : l.dir === 'in' ? '←' : '→'}</span>
                  <span style={{ fontFamily: MONO, fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                  <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{l.kind}</span>
                </div>
              ))}
              {det.lineage.length === 1 ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No foreign keys, views, saved queries or tests refer to this column.</span> : null}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sectionLabel('Access in the last 30 days')}
              {det.access.length ? det.access.map((a) => (
                <div key={a.who} style={{ display: 'flex', alignItems: 'center', gap: 9, height: 22 }}>
                  <span style={{ fontSize: 12, width: 110, flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.who}>{a.who}</span>
                  <div style={{ flex: 1, height: 6, background: 'var(--bg-inset)', borderRadius: 3, overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: (100 * a.n) / maxAccess + '%', background: 'var(--state-info)' }} />
                  </div>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{num(a.n)}</span>
                </div>
              )) : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Nobody queried {col.table} through Comb in 30 days.</span>}
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Statements on {col.table} from the audit trail, by member.</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sectionLabel('Retention')}
              <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)' }}>{det.retention}</div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
