import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import {
  DataEditor, GridCellKind, CompactSelection,
  type DataEditorRef, type DrawCellCallback, type DrawHeaderCallback, type GridCell, type GridColumn, type GridSelection, type Item, type Theme,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import type { TypeFamily } from '@comb/shared';
import {
  PAGE_SIZE, TABLE_SUBS, type ConstraintRow, type EditBody, type EditPreview, type EditResult, type IndexRow, type PolicyRow,
  type RowsResult, type TableColumn, type TableMeta, type TableSub, type TriggerRow,
} from '@comb/shared/src/table.ts';
import { api, ApiError } from '../lib/api.ts';
import { useApp, useConn, toastError, type Tab } from '../lib/store.ts';
import { useStatus } from '../lib/status.ts';
import { withConfirm } from '../lib/confirm.ts';
import { bytes, num } from '../lib/format.ts';
import { Button, ErrorBox, Kbd, Loading, Modal, MONO, COND, TYPE_COLOR, TextInput } from '../ui/index.tsx';

/*
 * Table tab: Data (Glide grid with server-side paging/sort/filter and staged edits),
 * Structure, Constraints, Indexes, Triggers and DDL. Edits are staged here and sent to the
 * server as structured changes; the server builds and runs the SQL under the policy.
 */

type Val = string | null;
interface StagedCore {
  /** rowKey → primary key + changed columns (Postgres text form, null = NULL). */
  edits: Record<string, { pk: Record<string, Val>; set: Record<string, Val> }>;
  deletes: Record<string, Record<string, Val>>;
  inserts: Array<{ id: string; values: Record<string, Val> }>;
}
interface Staged extends StagedCore {
  history: StagedCore[];
}
const EMPTY: Staged = { edits: {}, deletes: {}, inserts: [], history: [] };

/** Staged edits per tab, kept outside the component so switching tabs or sub-tabs keeps them. */
const useStaged = create<{ byTab: Record<string, Staged>; set: (tabId: string, fn: (s: Staged) => StagedCore, record?: boolean) => void; undo: (tabId: string) => boolean; clear: (tabId: string) => void }>((set, get) => ({
  byTab: {},
  set: (tabId, fn, record = true) => {
    const cur = get().byTab[tabId] ?? EMPTY;
    const next = fn(cur);
    const core: StagedCore = { edits: cur.edits, deletes: cur.deletes, inserts: cur.inserts };
    set({ byTab: { ...get().byTab, [tabId]: { ...next, history: record ? [...cur.history.slice(-199), core] : cur.history } } });
  },
  undo: (tabId) => {
    const cur = get().byTab[tabId];
    if (!cur?.history.length) return false;
    const prev = cur.history[cur.history.length - 1];
    set({ byTab: { ...get().byTab, [tabId]: { ...prev, history: cur.history.slice(0, -1) } } });
    return true;
  },
  clear: (tabId) => set({ byTab: { ...get().byTab, [tabId]: EMPTY } }),
}));

function pendingCount(s: Staged): number {
  return Object.keys(s.edits).filter((k) => !s.deletes[k]).length + Object.keys(s.deletes).length + s.inserts.length;
}

function editBodyOf(schema: string, table: string, s: Staged): EditBody {
  return {
    schema, table,
    updates: Object.entries(s.edits).filter(([k, e]) => !s.deletes[k] && Object.keys(e.set).length).map(([, e]) => ({ pk: e.pk, set: e.set })),
    deletes: Object.values(s.deletes).map((pk) => ({ pk })),
    inserts: s.inserts.map((i) => ({ values: i.values })),
  };
}

const SHORT: Array<[RegExp, string]> = [
  [/^bigint/, 'int8'], [/^integer/, 'int4'], [/^smallint/, 'int2'], [/^boolean/, 'bool'], [/^double precision/, 'float8'], [/^real/, 'float4'],
  [/^timestamp\((\d)\) with time zone/, 'timestamptz($1)'], [/^timestamp with time zone/, 'timestamptz'],
  [/^timestamp\((\d)\) without time zone/, 'timestamp($1)'], [/^timestamp without time zone/, 'timestamp'],
  [/^time with time zone/, 'timetz'], [/^time without time zone/, 'time'], [/^character varying/, 'varchar'], [/^character\b/, 'char'],
];
/** Short Postgres type names, as the mockup shows them (int8, timestamptz, bool). */
export function shortType(t: string): string {
  for (const [re, rep] of SHORT) if (re.test(t)) return t.replace(re, rep);
  return t;
}

const isJson = (type: string) => /^jsonb?$/.test(type);

/** Text form of a value as the server sent it (what an edit starts from). */
function toText(v: unknown, type: string): Val {
  if (v === null || v === undefined) return null;
  if (isJson(type)) return JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ── Theme from the CSS tokens ────────────────────────────────────

function readVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const names = ['--bg-base', '--bg-raised', '--bg-overlay', '--bg-inset', '--bg-hover', '--bg-selected', '--border-subtle', '--border-strong',
    '--text-primary', '--text-secondary', '--text-muted', '--text-inverse', '--state-info', '--state-running', '--state-success', '--state-null', '--danger',
    '--type-numeric', '--type-text', '--type-temporal', '--type-boolean', '--type-structured', '--type-identifier', '--type-other'];
  return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim() || '#888888']));
}

function alpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function useGridColors(): Record<string, string> {
  const theme = useApp((s) => s.theme);
  const [vars, setVars] = useState(readVars);
  useEffect(() => {
    // The shell applies data-theme in its own effect, which runs after ours: read on the next frame.
    const id = requestAnimationFrame(() => setVars(readVars()));
    return () => cancelAnimationFrame(id);
  }, [theme]);
  return vars;
}

const FONT = "'IBM Plex Mono', ui-monospace, monospace";
const COND_FONT = "'IBM Plex Sans Condensed', 'IBM Plex Sans', sans-serif";

function gridTheme(v: Record<string, string>): Partial<Theme> {
  return {
    accentColor: v['--state-info'], accentFg: v['--text-inverse'], accentLight: alpha(v['--state-info'], 0.16),
    textDark: v['--text-primary'], textMedium: v['--text-secondary'], textLight: v['--text-muted'], textBubble: v['--text-primary'],
    bgIconHeader: v['--text-muted'], fgIconHeader: v['--bg-base'], textHeader: v['--text-primary'], textHeaderSelected: v['--text-primary'],
    bgCell: v['--bg-base'], bgCellMedium: v['--bg-raised'], bgHeader: v['--bg-inset'], bgHeaderHasFocus: v['--bg-hover'], bgHeaderHovered: v['--bg-hover'],
    bgBubble: v['--bg-raised'], bgBubbleSelected: v['--bg-selected'], bgSearchResult: alpha(v['--state-running'], 0.25),
    borderColor: v['--border-subtle'], horizontalBorderColor: v['--border-subtle'], headerBottomBorderColor: v['--border-strong'],
    drilldownBorder: v['--border-strong'], linkColor: v['--state-info'],
    cellHorizontalPadding: 10, cellVerticalPadding: 4,
    headerFontStyle: '500 12px', baseFontStyle: '13px', markerFontStyle: '11px', fontFamily: FONT, editorFontSize: '13px', lineHeight: 1.4,
  };
}

const famColor = (v: Record<string, string>, f: TypeFamily) => v['--type-' + f] ?? v['--type-other'];

function colWidth(c: TableColumn): number {
  if (c.pk && c.family === 'numeric') return 92;
  if (c.type === 'uuid') return 290;
  switch (c.family) {
    case 'numeric': return 110;
    case 'boolean': return 96;
    case 'temporal': return 200;
    case 'structured': return 220;
    case 'identifier': return 160;
    default: return 200;
  }
}

// ── Screen ───────────────────────────────────────────────────────

export default function TableScreen({ tab }: { tab: Tab }) {
  const conn = useConn();
  const schema = String(tab.params?.schema ?? 'public');
  const table = String(tab.params?.table ?? tab.title);
  const sub: TableSub = (TABLE_SUBS as readonly string[]).includes(tab.params?.sub) ? tab.params!.sub : 'Data';
  const setSub = (s: TableSub) => useApp.getState().updateTab(tab.id, { params: { sub: s } });
  const qp = new URLSearchParams({ schema, table }).toString();
  const meta = useQuery({ queryKey: ['table-meta', conn.id, schema, table], queryFn: () => api.get<TableMeta>(`/table/${conn.id}/meta?${qp}`) });

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-base)' }}>
      <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)' }}>
        {TABLE_SUBS.map((l) => (
          <button key={l} onClick={() => setSub(l)}
            style={{ padding: '0 11px', fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
              color: sub === l ? 'var(--text-primary)' : 'var(--text-muted)', borderBottom: '2px solid ' + (sub === l ? 'var(--text-primary)' : 'transparent') }}>
            {l}
          </button>
        ))}
        <span className="spacer" />
        <span className="mono" style={{ alignSelf: 'center', paddingRight: 12, fontSize: 11, color: 'var(--text-muted)' }}>
          {schema}.{table}{meta.data && meta.data.kind !== 'table' ? ' · ' + meta.data.kind : ''}
        </span>
      </div>
      {meta.isLoading ? <Loading label="Reading the catalog…" /> : meta.error ? <ErrorBox error={meta.error} onRetry={() => meta.refetch()} /> : meta.data ? (
        sub === 'Data' ? <DataView tab={tab} meta={meta.data} />
          : sub === 'Structure' ? <StructureView meta={meta.data} qp={qp} />
            : sub === 'Constraints' ? <ConstraintsView qp={qp} />
              : sub === 'Indexes' ? <IndexesView qp={qp} />
                : sub === 'Triggers' ? <TriggersView qp={qp} />
                  : <DdlView qp={qp} />
      ) : null}
    </div>
  );
}

// ── Data ─────────────────────────────────────────────────────────

interface Cursor { after?: unknown[]; offset?: number }

function DataView({ tab, meta }: { tab: Tab; meta: TableMeta }) {
  const conn = useConn();
  const qc = useQueryClient();
  const density = useApp((s) => s.density);
  const toast = useApp((s) => s.toast);
  const report = useStatus((s) => s.report);
  const colors = useGridColors();
  const theme = useMemo(() => gridTheme(colors), [colors]);
  const { schema, table } = meta;
  const rowH = density === 'compact' ? 28 : 34;

  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  const [pages, setPages] = useState<Cursor[]>([{}]);
  const [page, setPage] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  const [inspector, setInspector] = useState(false);
  const [editing, setEditing] = useState<{ col: number; row: number; value: string; isNull: boolean } | null>(null);
  const [review, setReview] = useState(false);
  const [adding, setAdding] = useState(false);
  const gridRef = useRef<DataEditorRef>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setFilter(filterInput.trim()), 350);
    return () => clearTimeout(t);
  }, [filterInput]);
  const resetPaging = () => { setPages([{}]); setPage(0); };
  useEffect(resetPaging, [filter, sort?.col, sort?.dir]);

  const cursor = pages[page] ?? {};
  const rowsQ = useQuery({
    queryKey: ['table-rows', conn.id, schema, table, sort, filter, cursor],
    queryFn: () => api.post<RowsResult>(`/table/${conn.id}/rows`, { schema, table, sort: sort?.col, dir: sort?.dir, filter: filter || undefined, ...cursor }),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
  const data = rowsQ.data;
  const loadingFresh = rowsQ.isFetching && (rowsQ.isPlaceholderData || !data);

  useEffect(() => {
    if (rowsQ.isFetching) report({ state: 'running', lastQuery: `select … from ${schema}.${table}` });
    else if (rowsQ.error) report({ state: 'error', rows: '—', latency: '—' });
    else if (data) report({ state: 'idle', rows: `${num(data.rows.length)} rows loaded`, latency: `${data.ms} ms`, lastQuery: `select … from ${schema}.${table}`, schema });
  }, [rowsQ.isFetching, rowsQ.error, data, schema, table, report]);

  const staged = useStaged((s) => s.byTab[tab.id] ?? EMPTY);
  const setStaged = useStaged((s) => s.set);
  const count = pendingCount(staged);
  useEffect(() => {
    if (!!tab.dirty !== count > 0) useApp.getState().updateTab(tab.id, { dirty: count > 0 });
  }, [count, tab.id, tab.dirty]);

  const cols = meta.columns;
  const rows = data?.rows ?? [];
  const keys = data?.keys ?? null;
  const offset = page * PAGE_SIZE;
  const canEdit = meta.editable && !!keys;
  const nReal = rows.length;
  const totalRows = nReal + staged.inserts.length;
  const rowKey = (r: number) => (keys ? JSON.stringify(keys[r]) : '');
  const pkOf = (r: number): Record<string, Val> => Object.fromEntries(meta.pk.map((k, i) => [k, keys![r][i] as Val]));

  const columns: GridColumn[] = useMemo(() => cols.map((c) => ({ id: c.name, title: c.name, width: widths[c.name] ?? colWidth(c) })), [cols, widths]);

  /** Current value of a cell including staged edits: [text, dirty]. */
  const valueAt = useCallback((col: number, row: number): { v: unknown; staged: boolean; inserted: boolean } => {
    const c = cols[col];
    if (row >= nReal) {
      const ins = staged.inserts[row - nReal];
      return ins && c.name in ins.values ? { v: ins.values[c.name], staged: true, inserted: true } : { v: undefined, staged: false, inserted: true };
    }
    const e = keys ? staged.edits[rowKey(row)] : undefined;
    if (e && c.name in e.set) return { v: e.set[c.name], staged: true, inserted: false };
    return { v: rows[row]?.[col], staged: false, inserted: false };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, rows, keys, staged, nReal]);

  const getCellContent = useCallback(([col, row]: Item): GridCell => {
    const c = cols[col];
    const { v, staged: st, inserted } = valueAt(col, row);
    let text: string;
    let color = colors['--text-primary'];
    if (v === undefined) { text = c.identity || c.default ? 'default' : 'null'; color = colors['--text-muted']; }
    else if (v === null) { text = 'null'; color = colors['--state-null']; }
    else {
      text = st ? String(v) : (toText(v, c.type) ?? '');
      if (c.family === 'boolean') color = colors['--text-secondary'];
      else if (c.family === 'structured' && !c.type.endsWith('[]')) color = colors['--type-structured'];
    }
    const display = text.length > 300 ? text.slice(0, 300) + '…' : text.replace(/\n/g, ' ');
    return {
      kind: GridCellKind.Text, data: text, displayData: display, allowOverlay: false, readonly: true,
      contentAlign: c.family === 'numeric' && !c.type.endsWith('[]') ? 'right' : 'left',
      themeOverride: { textDark: color, ...(c.pk && !inserted ? { baseFontStyle: '500 13px' } : {}) },
    };
  }, [cols, valueAt, colors]);

  const drawHeader: DrawHeaderCallback = useCallback(({ ctx, column, columnIndex, rect, isHovered, isSelected }) => {
    const c = cols[columnIndex];
    if (!c) return;
    ctx.save();
    ctx.fillStyle = isSelected ? colors['--bg-selected'] : isHovered ? colors['--bg-hover'] : colors['--bg-inset'];
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.fillStyle = famColor(colors, c.family);
    ctx.fillRect(rect.x, rect.y, 2, rect.height);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width - 4, rect.height);
    ctx.clip();
    const x = rect.x + 10;
    ctx.textBaseline = 'middle';
    ctx.font = `500 12px ${FONT}`;
    ctx.fillStyle = colors['--text-primary'];
    ctx.fillText(column.title, x, rect.y + 14);
    let after = x + ctx.measureText(column.title).width + 5;
    if (c.pk || c.fk) {
      ctx.font = `9px ${FONT}`;
      ctx.fillText(c.pk ? '🔑' : '🔗', after, rect.y + 14);
      after += 14;
    }
    if (sort?.col === c.name) {
      ctx.font = `10px ${FONT}`;
      ctx.fillStyle = colors['--text-secondary'];
      ctx.fillText(sort.dir === 'asc' ? '↑' : '↓', after, rect.y + 14);
    }
    ctx.font = `500 11px ${COND_FONT}`;
    try { (ctx as any).letterSpacing = '0.66px'; } catch { /* older canvas */ }
    ctx.fillStyle = colors['--text-muted'];
    ctx.fillText(shortType(c.type).toUpperCase(), x, rect.y + 29);
    ctx.restore();
  }, [cols, colors, sort]);

  const drawCell: DrawCellCallback = useCallback((args, drawContent) => {
    const { ctx, rect, col, row } = args;
    const { staged: st, inserted } = valueAt(col, row);
    const deleted = row < nReal && !!keys && !!staged.deletes[rowKey(row)];
    // Glide caches canvas state between cells: every adornment restores what it changed.
    if (st && !inserted) {
      ctx.save();
      ctx.fillStyle = alpha(colors['--state-running'], 0.14);
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }
    if (deleted) { ctx.save(); ctx.globalAlpha = 0.6; }
    drawContent();
    if (deleted) ctx.restore();
    ctx.save();
    if (deleted) {
      ctx.strokeStyle = colors['--text-secondary'];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.x + 8, rect.y + rect.height / 2 + 0.5);
      ctx.lineTo(rect.x + rect.width - 8, rect.y + rect.height / 2 + 0.5);
      ctx.stroke();
    }
    if (st && !inserted) {
      ctx.fillStyle = colors['--state-running'];
      ctx.beginPath();
      ctx.moveTo(rect.x + rect.width - 6, rect.y);
      ctx.lineTo(rect.x + rect.width, rect.y);
      ctx.lineTo(rect.x + rect.width, rect.y + 6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueAt, nReal, keys, staged.deletes, colors]);

  const getRowThemeOverride = useCallback((row: number): Partial<Theme> | undefined => {
    if (row >= nReal) return { bgCell: alpha(colors['--state-success'], 0.1) };
    if (keys && staged.deletes[rowKey(row)]) return { bgCell: alpha(colors['--danger'], 0.1) };
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nReal, keys, staged.deletes, colors]);

  const explainReadOnly = () => toast('Read-only', meta.readOnlyReason ?? 'This grid cannot be edited.', 'info');

  // ── Editing ──
  const startEdit = (col: number, row: number) => {
    if (row < nReal && !canEdit) { explainReadOnly(); return; }
    const c = cols[col];
    if (c.generated || c.identity === 'a') { toast('Not editable', `${c.name} is generated by the database.`, 'info'); return; }
    const { v, staged: st } = valueAt(col, row);
    const text = v === undefined || v === null ? null : st ? String(v) : toText(v, c.type);
    setEditing({ col, row, value: text ?? '', isNull: text === null });
  };

  const commitEdit = (value: Val) => {
    if (!editing) return;
    const { col, row } = editing;
    setEditing(null);
    const c = cols[col];
    if (row >= nReal) {
      const id = staged.inserts[row - nReal]?.id;
      setStaged(tab.id, (s) => ({ ...s, inserts: s.inserts.map((i) => (i.id === id ? { ...i, values: { ...i.values, [c.name]: value } } : i)) }));
    } else {
      const rk = rowKey(row);
      const original = toText(rows[row][col], c.type);
      setStaged(tab.id, (s) => {
        const e = s.edits[rk] ?? { pk: pkOf(row), set: {} };
        const set = { ...e.set };
        if (value === original) delete set[c.name];
        else set[c.name] = value;
        const edits = { ...s.edits };
        if (Object.keys(set).length) edits[rk] = { ...e, set };
        else delete edits[rk];
        return { ...s, edits };
      });
    }
    setTimeout(() => gridRef.current?.focus(), 0);
  };

  const toggleDelete = (gs: GridSelection = selection) => {
    if (!canEdit) { explainReadOnly(); return; }
    let sel: number[] = gs.rows.toArray();
    if (!sel.length && gs.current) sel = [gs.current.cell[1]];
    if (!sel.length) { toast('Select rows first', 'Click row numbers (⇧/⌘ for more), then ⌫ Delete.', 'info'); return; }
    setStaged(tab.id, (s) => {
      const deletes = { ...s.deletes };
      let inserts = s.inserts;
      const real = sel.filter((r) => r < nReal);
      const allMarked = real.length > 0 && real.every((r) => deletes[rowKey(r)]);
      for (const r of real) {
        if (allMarked) delete deletes[rowKey(r)];
        else deletes[rowKey(r)] = pkOf(r);
      }
      const drop = new Set(sel.filter((r) => r >= nReal).map((r) => s.inserts[r - nReal]?.id));
      if (drop.size) inserts = inserts.filter((i) => !drop.has(i.id));
      return { ...s, deletes, inserts };
    });
  };

  const addRow = (values: Record<string, Val>) => {
    setStaged(tab.id, (s) => ({ ...s, inserts: [...s.inserts, { id: Math.random().toString(36).slice(2), values }] }));
    setAdding(false);
    setTimeout(() => gridRef.current?.scrollTo(0, totalRows), 50);
  };
  const required = cols.filter((c) => c.required);
  const onAdd = () => {
    if (!meta.editable) { explainReadOnly(); return; }
    if (required.length) setAdding(true);
    else addRow({});
  };

  const undo = () => {
    if (useStaged.getState().undo(tab.id)) toast('Undid the last staged change', undefined, 'info');
  };

  const onKeyDown = (e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; cancel: () => void; preventDefault: () => void }) => {
    if (e.key === ' ' && !e.metaKey && !e.ctrlKey) { e.cancel(); e.preventDefault(); setInspector((x) => !x); }
    else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.cancel(); e.preventDefault(); undo(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && count) { e.cancel(); e.preventDefault(); setReview(true); }
  };

  const onHeaderClicked = (col: number) => {
    const name = cols[col]?.name;
    if (!name) return;
    setSort((s) => (s?.col !== name ? { col: name, dir: 'asc' } : s.dir === 'asc' ? { col: name, dir: 'desc' } : null));
  };

  // Editor overlay position
  const editorBox = (() => {
    if (!editing || !boxRef.current) return null;
    const b = gridRef.current?.getBounds(editing.col, editing.row);
    if (!b) return null;
    const host = boxRef.current.getBoundingClientRect();
    return { left: b.x - host.left, top: b.y - host.top, width: Math.max(b.width, 220), height: b.height };
  })();

  const cur = selection.current?.cell;
  const inspectorCell = cur && cur[0] < cols.length && cur[1] < totalRows ? { col: cols[cur[0]], row: cur[1], ...valueAt(cur[0], cur[1]) } : null;
  const estimate = meta.estimate;
  const pageLabel = rows.length
    ? `rows ${num(offset + 1)}–${num(offset + rows.length)}${filter ? ' (filtered)' : ''}${estimate !== null ? ` of ${meta.exactCount ? '' : '~'}${num(estimate)}` : ''}`
    : `0 rows${estimate !== null ? ` of ${meta.exactCount ? '' : '~'}${num(estimate)}` : ''}`;
  const readOnly = !meta.editable;
  const softRo = readOnly && (meta.kind === 'view' || meta.kind === 'matview' || meta.kind === 'foreign' || !meta.pk.length);
  const writeBtn: React.CSSProperties = { height: 22, padding: '0 8px', borderRadius: 3, fontSize: 12, whiteSpace: 'nowrap', flex: 'none', border: '1px solid var(--border-subtle)',
    color: readOnly ? 'var(--text-muted)' : 'var(--text-secondary)', opacity: readOnly ? 0.5 : 1 };

  const goNext = () => {
    if (!data?.hasMore) return;
    const next: Cursor = data.paging === 'keyset' && keys ? { after: keys[keys.length - 1] } : { offset: offset + PAGE_SIZE };
    setPages((p) => [...p.slice(0, page + 1), next]);
    setPage(page + 1);
  };
  const goPrev = () => page > 0 && setPage(page - 1);

  return (
    <>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        <button className={readOnly ? undefined : 'hov'} onClick={onAdd} style={writeBtn} title={readOnly ? meta.readOnlyReason ?? '' : 'Stage an INSERT'}>+ Add row</button>
        <button className={readOnly ? undefined : 'hov'} onClick={() => toggleDelete()} style={writeBtn} title={readOnly ? meta.readOnlyReason ?? '' : 'Mark the selected rows for deletion (⌫)'}>⌫ Delete</button>
        <button className="hov hov-text" title="Reload" onClick={() => { void qc.invalidateQueries({ queryKey: ['table-rows', conn.id, schema, table] }); void qc.invalidateQueries({ queryKey: ['table-meta', conn.id, schema, table] }); }}
          style={{ height: 22, padding: '0 8px', borderRadius: 3, fontSize: 12, color: 'var(--text-secondary)' }}>⟳</button>
        <div style={{ width: 1, height: 16, background: 'var(--border-subtle)', margin: '0 2px' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px', background: 'var(--bg-raised)', border: '1px solid var(--border-subtle)', borderRadius: 3, width: 200 }}>
          <input value={filterInput} onChange={(e) => setFilterInput(e.target.value)} placeholder="filter…" aria-label="Filter rows"
            onKeyDown={(e) => { if (e.key === 'Escape') setFilterInput(''); if (e.key === 'Enter') setFilter(filterInput.trim()); }}
            style={{ flex: 1, fontFamily: MONO, fontSize: 12, minWidth: 0 }} />
          {filterInput ? <button onClick={() => setFilterInput('')} className="hov-text" style={{ color: 'var(--text-muted)', fontSize: 11 }} title="Clear filter">✕</button> : null}
        </div>
        <span style={{ flex: 1, minWidth: 8 }} />
        {meta.needsApproval && meta.editable ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>changes need approval</span> : null}
        {readOnly ? (
          <button onClick={explainReadOnly} className="hov-text"
            style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none' }}>
            🔒 Read-only
          </button>
        ) : null}
        {count ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--state-running)' }}>⚠ {count} pending change{count === 1 ? '' : 's'}</span>
            <button onClick={() => setReview(true)} style={{ height: 22, padding: '0 10px', borderRadius: 3, background: 'var(--btn-primary)', color: 'var(--text-inverse)', fontSize: 12, fontWeight: 500 }}>Review</button>
            <button onClick={() => setStaged(tab.id, () => ({ edits: {}, deletes: {}, inserts: [] }))} className="hov-text"
              style={{ height: 22, padding: '0 8px', border: '1px solid var(--border-subtle)', borderRadius: 3, fontSize: 12, color: 'var(--text-secondary)' }}>Discard</button>
          </div>
        ) : null}
      </div>
      {softRo ? (
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)', borderLeft: '3px solid var(--state-info)', fontSize: 12, color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--state-info)' }}>◆</span>{meta.readOnlyReason}
        </div>
      ) : null}
      {data && meta.editable && !keys ? (
        <div style={{ flex: 'none', padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)', borderLeft: '3px solid var(--state-running)', fontSize: 12, color: 'var(--text-secondary)' }}>
          ⚠ The primary key is masked for you, so rows on this page cannot be edited.
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={boxRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {rowsQ.error && !data ? <ErrorBox error={rowsQ.error} onRetry={() => rowsQ.refetch()} /> : (
              <DataEditor
                ref={gridRef}
                width="100%"
                height="100%"
                columns={columns}
                rows={totalRows}
                getCellContent={getCellContent}
                getCellsForSelection={true}
                theme={theme}
                rowHeight={rowH}
                headerHeight={40}
                rowMarkers={{ kind: 'clickable-number', startIndex: offset + 1, width: 46, theme: { bgCell: colors['--bg-inset'], textLight: colors['--text-muted'], textDark: colors['--text-muted'], markerFontStyle: '11px' } }}
                drawHeader={drawHeader}
                drawCell={drawCell}
                getRowThemeOverride={getRowThemeOverride}
                onHeaderClicked={onHeaderClicked}
                onColumnResize={(col, w) => setWidths((x) => ({ ...x, [String(col.id)]: w }))}
                gridSelection={selection}
                onGridSelectionChange={setSelection}
                onCellActivated={([c, r]) => startEdit(c, r)}
                cellActivationBehavior="double-click"
                keybindings={{ activateCell: 'Enter|shift+Enter', delete: 'Backspace|Delete', search: false }}
                onDelete={(gs) => { toggleDelete(gs); return false; }}
                onKeyDown={onKeyDown}
                rowSelect="multi"
                columnSelect="none"
                smoothScrollX
                smoothScrollY
                maxColumnWidth={640}
                minColumnWidth={60}
              />
            )}
            {loadingFresh ? <Skeleton cols={columns} rowH={rowH} /> : null}
            {!loadingFresh && data && totalRows === 0 ? (
              <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 0, background: 'var(--bg-base)', padding: '56px 20px', textAlign: 'center' }}>
                {filter ? (
                  <>
                    <div style={{ fontSize: 24, lineHeight: '30px', fontWeight: 600, marginBottom: 6 }}>No rows match that filter.</div>
                    <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)', marginBottom: 14 }}>
                      The filter <span className="mono">{filter}</span> returned nothing{estimate !== null ? ` from ${meta.exactCount ? '' : '~'}${num(estimate)} rows` : ''}.
                    </div>
                    <Button onClick={() => { setFilterInput(''); setFilter(''); }}>Clear filter</Button>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 24, lineHeight: '30px', fontWeight: 600, marginBottom: 6 }}>{page > 0 ? 'No more rows.' : 'This table is empty.'}</div>
                    <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)' }}>{meta.editable ? '+ Add row stages an INSERT.' : ''}</div>
                  </>
                )}
              </div>
            ) : null}
            {editing && editorBox ? (
              <CellEditor box={editorBox} initial={editing.value} initialNull={editing.isNull} col={cols[editing.col]}
                onCommit={commitEdit} onCancel={() => { setEditing(null); setTimeout(() => gridRef.current?.focus(), 0); }} />
            ) : null}
          </div>
          <div style={{ height: 28, flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: '0 10px', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-raised)' }}>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>{pageLabel}</span>
            <div style={{ display: 'flex', gap: 2 }}>
              <button title="Previous page" disabled={page === 0} onClick={goPrev} className="hov hov-text" style={{ width: 20, height: 20, borderRadius: 2, color: 'var(--text-muted)', fontSize: 12 }}>‹</button>
              <button title="Next page" disabled={!data?.hasMore} onClick={goNext} className="hov hov-text" style={{ width: 20, height: 20, borderRadius: 2, color: 'var(--text-secondary)', fontSize: 12 }}>›</button>
            </div>
            <span title={data?.paging === 'keyset' ? 'Keyset pagination on the primary key' : 'Offset pagination'}
              style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', border: '1px solid var(--border-subtle)', borderRadius: 3, padding: '0 6px' }}>
              {PAGE_SIZE} / page{data ? ' · ' + data.paging : ''}
            </span>
            <span style={{ flex: 1 }} />
            {canEdit ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>double-click or <Kbd>↵</Kbd> edits · <Kbd>⌘Z</Kbd> undo</span> : null}
            <button onClick={() => setInspector((x) => !x)} className="hov-text" style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              ⇱ inspector <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>Space</span>
            </button>
          </div>
        </div>
        {inspector ? <Inspector cell={inspectorCell} absRow={inspectorCell ? (inspectorCell.row < nReal ? offset + inspectorCell.row + 1 : null) : null} onClose={() => setInspector(false)} colors={colors} /> : null}
      </div>

      {review ? <ReviewModal tab={tab} meta={meta} staged={staged} onClose={() => setReview(false)} onApplied={() => {
        useStaged.getState().clear(tab.id);
        setReview(false);
        void qc.invalidateQueries({ queryKey: ['table-rows', conn.id, schema, table] });
        void qc.invalidateQueries({ queryKey: ['table-meta', conn.id, schema, table] });
      }} /> : null}
      {adding ? <AddRowModal cols={cols} required={required} onClose={() => setAdding(false)} onAdd={addRow} /> : null}
    </>
  );
}

function Skeleton({ cols, rowH }: { cols: GridColumn[]; rowH: number }) {
  const widths = cols.map((c) => ('width' in c ? c.width : 150));
  return (
    <div aria-busy="true" style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 0, background: 'var(--bg-base)', overflow: 'hidden' }}>
      {Array.from({ length: 14 }, (_, i) => (
        <div key={i} style={{ display: 'flex', height: rowH, borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ width: 46, flex: 'none', borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-inset)' }} />
          {widths.map((w, j) => (
            <div key={j} style={{ width: w, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)' }}>
              <div className="skeleton" style={{ height: 8, width: `${40 + (((i + 1) * 37 + j * 13) % 50)}%` }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function CellEditor({ box, initial, initialNull, col, onCommit, onCancel }: {
  box: { left: number; top: number; width: number; height: number }; initial: string; initialNull: boolean; col: TableColumn;
  onCommit: (v: Val) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [isNull, setNull] = useState(initialNull);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const born = useRef(Date.now());
  useEffect(() => {
    // The grid re-focuses its canvas right after activation; take focus back once it has.
    const ids = [0, 60, 150].map((ms) => setTimeout(() => { input.current?.focus(); input.current?.select(); }, ms));
    return () => ids.forEach(clearTimeout);
  }, []);
  const finish = (v: Val | undefined) => {
    if (done.current) return;
    done.current = true;
    if (v === undefined) onCancel();
    else onCommit(v);
  };
  return (
    <div style={{ position: 'absolute', left: box.left, top: box.top, width: box.width, height: box.height, zIndex: 5, display: 'flex', alignItems: 'center',
      background: 'var(--bg-inset)', outline: '2px solid var(--state-info)', boxShadow: 'var(--shadow)' }}>
      <input ref={input} value={isNull ? '' : value} placeholder={isNull ? 'null' : ''}
        onChange={(e) => { setNull(false); setValue(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); finish(isNull ? null : value); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(undefined); }
        }}
        onBlur={() => { if (Date.now() - born.current < 250) return; finish(isNull ? null : value); }}
        aria-label={`Edit ${col.name}`}
        style={{ flex: 1, minWidth: 0, height: '100%', padding: '0 10px', fontFamily: MONO, fontSize: 13, color: 'var(--text-primary)' }} />
      {!col.notNull ? (
        <button onMouseDown={(e) => { e.preventDefault(); finish(null); }} title="Set NULL"
          style={{ flex: 'none', height: 18, margin: '0 6px', padding: '0 5px', border: '1px solid var(--border-strong)', borderRadius: 3, fontFamily: MONO, fontSize: 10, color: 'var(--text-secondary)' }}>
          NULL
        </button>
      ) : null}
    </div>
  );
}

// ── Inspector ────────────────────────────────────────────────────

function Inspector({ cell, absRow, onClose, colors }: {
  cell: { col: TableColumn; row: number; v: unknown; staged: boolean; inserted: boolean } | null; absRow: number | null; onClose: () => void; colors: Record<string, string>;
}) {
  const [mode, setMode] = useState<'pretty' | 'tree' | 'raw'>('pretty');
  const toast = useApp((s) => s.toast);
  const col = cell?.col;
  const v = cell?.v;
  const raw = cell && v !== undefined && v !== null ? (cell.staged ? String(v) : toText(v, col!.type) ?? '') : null;
  let parsed: unknown = undefined;
  if (raw !== null && col && (isJson(col.type) || /^\s*[{[]/.test(raw))) {
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  }
  const pretty = parsed !== undefined && typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed, null, 2) : raw;
  const size = raw === null ? 0 : new TextEncoder().encode(raw).length;
  const famC = col ? famColor(colors, col.family) : colors['--type-other'];
  const btn = (m: typeof mode, label: string, disabled = false) => (
    <button disabled={disabled} onClick={() => setMode(m)} className="hov-text"
      style={{ fontSize: 12, color: mode === m ? 'var(--text-primary)' : 'var(--text-secondary)', textDecoration: mode === m ? 'underline' : 'none', textUnderlineOffset: 3 }}>{label}</button>
  );
  return (
    <div style={{ width: 320, flex: 'none', background: 'var(--bg-raised)', borderLeft: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span className="label">Value inspector</span>
        <span className="spacer" />
        <button onClick={onClose} className="hov-text" style={{ color: 'var(--text-muted)', fontSize: 12 }} title="Close (Space)">✕</button>
      </div>
      {!cell || !col ? (
        <div style={{ padding: 14, fontSize: 12, color: 'var(--text-muted)' }}>Select a cell to inspect its value.</div>
      ) : (
        <>
          <div style={{ padding: 10, borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontFamily: MONO, fontSize: 12 }}>{col.name}{cell.staged ? <span style={{ color: 'var(--state-running)' }}> · staged</span> : null}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: famC, border: '1px solid ' + famC, padding: '0 4px' }}>{shortType(col.type)}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{absRow ? `row ${num(absRow)}` : 'new row'} · {raw === null ? 'null' : bytes(size)}</span>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 10 }}>
            {raw === null ? <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--state-null)' }}>{v === undefined ? 'default' : 'null'}</span>
              : mode === 'tree' && parsed !== undefined ? <div style={{ fontFamily: MONO, fontSize: 12, lineHeight: '18px' }}><JsonTree value={parsed} /></div>
                : <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: '18px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{mode === 'raw' ? raw : pretty}</pre>}
          </div>
          <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: '0 10px', borderTop: '1px solid var(--border-subtle)' }}>
            <button className="hov-text" style={{ fontSize: 12, color: 'var(--text-secondary)' }} disabled={raw === null}
              onClick={() => { void navigator.clipboard?.writeText(raw ?? '').then(() => toast('Copied value', `${col.name} · ${bytes(size)}`, 'info')); }}>Copy</button>
            {btn('pretty', 'Pretty')}
            {btn('tree', 'Tree', parsed === undefined)}
            {btn('raw', 'Raw')}
          </div>
        </>
      )}
    </div>
  );
}

function JsonTree({ value, name, depth = 0 }: { value: unknown; name?: string; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === 'object';
  const keyEl = name !== undefined ? <span style={{ color: 'var(--text-secondary)' }}>{name}: </span> : null;
  if (!isObj) {
    const color = value === null ? 'var(--state-null)' : typeof value === 'string' ? 'var(--type-text)' : typeof value === 'number' ? 'var(--type-numeric)' : 'var(--type-boolean)';
    return <div style={{ paddingLeft: depth ? 14 : 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{keyEl}<span style={{ color }}>{JSON.stringify(value)}</span></div>;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const [o, c] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return (
    <div style={{ paddingLeft: depth ? 14 : 0 }}>
      <button onClick={() => setOpen(!open)} style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-primary)', textAlign: 'left' }}>
        <span style={{ color: 'var(--text-muted)', display: 'inline-block', width: 12, fontSize: 9 }}>{open ? '▾' : '▸'}</span>
        {keyEl}{o}{open ? '' : ` ${entries.length} ${Array.isArray(value) ? 'items' : 'keys'} ${c}`}
      </button>
      {open ? (
        <>
          {entries.map(([k, v]) => <JsonTree key={k} name={k} value={v} depth={depth + 1} />)}
          <div style={{ paddingLeft: 12 }}>{c}</div>
        </>
      ) : null}
    </div>
  );
}

// ── Review / Apply ───────────────────────────────────────────────

function ReviewModal({ tab, meta, staged, onClose, onApplied }: { tab: Tab; meta: TableMeta; staged: Staged; onClose: () => void; onApplied: () => void }) {
  const conn = useConn();
  const toast = useApp((s) => s.toast);
  const body = editBodyOf(meta.schema, meta.table, staged);
  const bodyKey = JSON.stringify(body);
  const preview = useQuery({
    queryKey: ['table-preview', conn.id, bodyKey],
    queryFn: () => api.post<EditPreview>(`/table/${conn.id}/preview`, body),
    enabled: pendingCount(staged) > 0,
    staleTime: Infinity,
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const n = pendingCount(staged);
  useEffect(() => { if (!n) onClose(); }, [n, onClose]);
  const set = useStaged.getState().set;

  const discard = (kind: string, i: number) => {
    set(tab.id, (s) => {
      if (kind === 'DELETE') return { ...s, deletes: {} };
      if (kind === 'INSERT') return { ...s, inserts: [] };
      const live = Object.entries(s.edits).filter(([k, e]) => !s.deletes[k] && Object.keys(e.set).length);
      const key = live[i]?.[0];
      const edits = { ...s.edits };
      if (key) delete edits[key];
      return { ...s, edits };
    });
  };

  const apply = async () => {
    setBusy(true);
    try {
      const r = await withConfirm((confirm) => api.post<EditResult>(`/table/${conn.id}/apply`, { ...body, confirm }), {
        title: `Write to ${conn.name}`, body: `${n} staged change${n === 1 ? '' : 's'} to ${meta.schema}.${meta.table} run in one transaction.`,
      });
      if (!r) return;
      if (r.approvalId) {
        toast(`Sent for approval ap-${r.approvalId}`, 'A second person must approve it before it runs.', 'info');
      } else {
        const affected = r.statements.reduce((a, s) => a + (s.rowCount ?? 0), 0);
        const missed = r.statements.filter((s) => s.command !== 'INSERT' && s.rowCount === 0).length;
        toast(`Applied ${r.statements.length} statement${r.statements.length === 1 ? '' : 's'} in one transaction`,
          `COMMIT · ${r.ms} ms · ${num(affected)} row${affected === 1 ? '' : 's'} affected${missed ? ` · ${missed} matched no row (changed elsewhere?)` : ''}`, missed ? 'info' : 'success');
      }
      onApplied();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message + (e.body?.detail ? ` — ${e.body.detail}` : '') : String(e);
      toast('Not applied — rolled back', msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  const kindColor = (k: string) => (k === 'DELETE' ? 'var(--danger)' : k === 'INSERT' ? 'var(--state-success)' : 'var(--state-running)');
  let upd = -1;
  return (
    <Modal width={680} onClose={onClose}
      title={<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span>Review {n} change{n === 1 ? '' : 's'}</span><span className="spacer" />
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>one transaction · {meta.schema}.{meta.table}</span></div>}
      footer={<>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {meta.needsApproval ? <>Goes to the approvals queue; runs inside <span className="mono">BEGIN … COMMIT</span> once approved.</> : <>Runs inside <span className="mono">BEGIN … COMMIT</span>. Failure rolls everything back.</>}
        </span>
        <span className="spacer" />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !preview.data} onClick={apply}>{busy ? 'Applying…' : meta.needsApproval ? 'Request approval' : 'Apply'}</Button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {preview.isLoading ? <Loading label="Building statements…" /> : null}
        {preview.error ? <ErrorBox error={preview.error} /> : null}
        {preview.data?.statements.map((s, i) => {
          if (s.kind === 'UPDATE') upd++;
          const idx = upd;
          return (
            <div key={i} style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 10px', background: 'var(--bg-raised)' }}>
              <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: kindColor(s.kind), width: 56, flex: 'none', paddingTop: 2 }}>{s.kind}</span>
              <pre style={{ flex: 1, margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{s.sql}</pre>
              <button onClick={() => discard(s.kind, idx)} style={{ fontSize: 11, color: 'var(--text-muted)' }} className="hov-text" title={s.kind === 'UPDATE' ? 'Discard this row\'s edits' : `Discard all staged ${s.kind.toLowerCase()}s`}>discard</button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function AddRowModal({ cols, required, onClose, onAdd }: { cols: TableColumn[]; required: TableColumn[]; onClose: () => void; onAdd: (v: Record<string, Val>) => void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const missing = required.filter((c) => !(vals[c.name] ?? '').length);
  return (
    <Modal title="Add row" width={460} onClose={onClose}
      footer={<>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Staged until you Review and Apply.</span>
        <span className="spacer" />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={missing.length > 0} onClick={() => onAdd(Object.fromEntries(required.map((c) => [c.name, vals[c.name]])))}>Stage INSERT</Button>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          These columns are not null and have no default. The other {cols.length - required.length} columns can be filled in the grid afterwards, or left to their defaults.
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (!missing.length) onAdd(Object.fromEntries(required.map((c) => [c.name, vals[c.name]]))); }}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {required.map((c) => (
            <label key={c.name} style={{ display: 'grid', gridTemplateColumns: '150px 1fr', alignItems: 'center', gap: 10 }}>
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontFamily: MONO, fontSize: 12 }}>{c.name}</span>
                <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: TYPE_COLOR[c.family] }}>{shortType(c.type)}</span>
              </span>
              <TextInput mono value={vals[c.name] ?? ''} onChange={(e) => setVals({ ...vals, [c.name]: e.target.value })} />
            </label>
          ))}
          <button type="submit" hidden />
        </form>
      </div>
    </Modal>
  );
}

// ── Structure and catalog panels ─────────────────────────────────

const headCell: React.CSSProperties = { padding: '5px 10px' };
const monoCell: React.CSSProperties = { padding: '6px 10px', fontFamily: MONO, fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/** Bordered table in the mockup's Structure shape: inset condensed header, mono rows. */
function StructTable({ head, template, rows, empty }: { head: string[]; template: string; rows: Array<{ key: string; cells: React.ReactNode[]; title?: string }>; empty?: string }) {
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: template, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        {head.map((h) => <div key={h} style={headCell}>{h}</div>)}
      </div>
      {rows.map((r, i) => (
        <div key={r.key} className="row-hover" title={r.title} style={{ display: 'grid', gridTemplateColumns: template, borderTop: i ? '1px solid var(--border-subtle)' : 'none', alignItems: 'center' }}>
          {r.cells.map((c, j) => <div key={j} style={{ ...monoCell, ...(j > 0 ? { color: 'var(--text-secondary)' } : {}) }}>{c}</div>)}
        </div>
      ))}
      {!rows.length ? <div style={{ padding: '18px 10px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>{empty ?? 'None.'}</div> : null}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="label" style={{ marginBottom: 8 }}>{children}</div>;
}

function Mark({ col }: { col: TableColumn }) {
  return <span style={{ fontSize: 9, opacity: col.pk || col.fk ? 1 : 0 }} title={col.pk ? 'primary key' : col.fk ? 'references ' + col.fk : undefined}>{col.pk ? '🔑' : col.fk ? '🔗' : ''}</span>;
}

function RlsBanner({ meta }: { meta: TableMeta }) {
  if (!meta.rls.enabled) return null;
  const n = meta.rls.policies;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--border-strong)', borderLeft: '3px solid var(--state-info)', borderRadius: 3, marginBottom: 14, fontSize: 13, color: 'var(--text-secondary)' }}>
      <span style={{ color: 'var(--state-info)' }}>◆</span>
      <span>
        Row-level security is <span style={{ fontFamily: MONO, color: 'var(--text-primary)' }}>ENABLED</span>{meta.rls.forced ? <> and <span style={{ fontFamily: MONO, color: 'var(--text-primary)' }}>FORCED</span></> : null} on this table — {n} {n === 1 ? 'policy applies' : 'policies apply'}, so what you see may be a subset.
        {n === 0 ? ' With no policy, only the owner (and superusers) see rows.' : ''}
      </span>
    </div>
  );
}

function StructureView({ meta, qp }: { meta: TableMeta; qp: string }) {
  const conn = useConn();
  const cons = useQuery({ queryKey: ['table-constraints', conn.id, qp], queryFn: () => api.get<{ constraints: ConstraintRow[]; policies: PolicyRow[] }>(`/table/${conn.id}/constraints?${qp}`) });
  const idx = useQuery({ queryKey: ['table-indexes', conn.id, qp], queryFn: () => api.get<{ indexes: IndexRow[] }>(`/table/${conn.id}/indexes?${qp}`) });
  const list: Array<{ kind: string; name: string; def: string }> = [
    ...(cons.data?.constraints ?? []).map((c) => ({ kind: c.kind, name: c.name, def: c.def })),
    ...(idx.data?.indexes ?? []).filter((i) => !i.constraint).map((i) => ({ kind: 'index', name: i.name, def: i.def.replace(/^.* USING /, '') })),
    ...(cons.data?.policies ?? []).map((p) => ({ kind: 'policy', name: p.name, def: `for ${p.cmd} to ${p.roles}${p.using ? ` using (${p.using})` : ''}${p.check ? ` with check (${p.check})` : ''}` })),
  ];
  return (
    <div className="screen" style={{ padding: 14 }}>
      <RlsBanner meta={meta} />
      {meta.comment ? <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>{meta.comment}</div> : null}
      <SectionLabel>Columns</SectionLabel>
      <div style={{ marginBottom: 20 }}>
        <StructTable head={['Name', 'Type', 'Nullable', 'Default', 'Comment']} template="1.2fr 1fr .7fr 1fr 1.4fr"
          rows={meta.columns.map((c) => ({
            key: c.name,
            title: c.fk ? `references ${c.fk}` : undefined,
            cells: [
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span><Mark col={c} /></span>,
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 2, height: 14, background: TYPE_COLOR[c.family], display: 'inline-block', flex: 'none' }} />{shortType(c.type)}</span>,
              c.notNull ? 'not null' : 'null',
              c.identity ? `identity (${c.identity === 'a' ? 'always' : 'by default'})` : c.generated ? 'generated' : c.default ?? '—',
              <span style={{ fontFamily: 'var(--sans)', color: 'var(--text-muted)' }}>{c.comment ?? ''}</span>,
            ],
          }))} />
      </div>
      <SectionLabel>Constraints &amp; indexes</SectionLabel>
      {cons.isLoading || idx.isLoading ? <Loading /> : cons.error ? <ErrorBox error={cons.error} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map((k) => (
            <div key={k.kind + k.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', border: '1px solid var(--border-subtle)', borderRadius: 3, minWidth: 0 }}>
              <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-muted)', width: 74, flex: 'none' }}>{k.kind}</span>
              <span style={{ fontFamily: MONO, fontSize: 13, flex: 'none' }}>{k.name}</span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={k.def}>{k.def}</span>
            </div>
          ))}
          {!list.length ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No constraints, indexes or policies.</div> : null}
        </div>
      )}
    </div>
  );
}

function ConstraintsView({ qp }: { qp: string }) {
  const conn = useConn();
  const q = useQuery({ queryKey: ['table-constraints', conn.id, qp], queryFn: () => api.get<{ constraints: ConstraintRow[]; policies: PolicyRow[] }>(`/table/${conn.id}/constraints?${qp}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  return (
    <div className="screen" style={{ padding: 14 }}>
      <SectionLabel>Constraints · {d.constraints.length}</SectionLabel>
      <div style={{ marginBottom: 20 }}>
        <StructTable head={['Name', 'Kind', 'Definition', 'Flags']} template="1.1fr .7fr 2.4fr .8fr" empty="No constraints on this table."
          rows={d.constraints.map((c) => ({ key: c.name, title: c.def, cells: [
            c.name, c.kind, c.def,
            [c.deferrable ? 'deferrable' : '', c.validated ? '' : 'not valid'].filter(Boolean).join(' · ') || '—',
          ] }))} />
      </div>
      <SectionLabel>Row-level security policies · {d.policies.length}</SectionLabel>
      <StructTable head={['Name', 'Command', 'Roles', 'Using', 'With check']} template="1.1fr .6fr .8fr 1.4fr 1.2fr" empty="No policies."
        rows={d.policies.map((p) => ({ key: p.name, title: p.using ?? undefined, cells: [
          p.name, `${p.cmd}${p.permissive ? '' : ' · restrictive'}`, p.roles, p.using ?? '—', p.check ?? '—',
        ] }))} />
    </div>
  );
}

function IndexesView({ qp }: { qp: string }) {
  const conn = useConn();
  const q = useQuery({ queryKey: ['table-indexes', conn.id, qp], queryFn: () => api.get<{ indexes: IndexRow[] }>(`/table/${conn.id}/indexes?${qp}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data!.indexes;
  return (
    <div className="screen" style={{ padding: 14 }}>
      <SectionLabel>Indexes · {rows.length}</SectionLabel>
      <StructTable head={['Name', 'Definition', 'Kind', 'Size', 'Scans', 'Tuples read']} template="1.2fr 2.4fr .7fr .6fr .6fr .7fr" empty="No indexes on this table."
        rows={rows.map((i) => ({ key: i.name, title: i.def, cells: [
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{i.name}{!i.valid ? <span style={{ fontFamily: COND, fontSize: 11, color: 'var(--state-error)' }}>INVALID</span> : null}</span>,
          i.def.replace(/^.* USING /, ''),
          i.primary ? 'primary' : i.unique ? 'unique' : '—',
          <span style={{ display: 'block', textAlign: 'right' }}>{bytes(i.size)}</span>,
          <span style={{ display: 'block', textAlign: 'right', color: i.scans === 0 ? 'var(--state-running)' : undefined }} title={i.scans === 0 ? 'Never used since statistics were reset' : undefined}>{i.scans === null ? '—' : num(i.scans)}</span>,
          <span style={{ display: 'block', textAlign: 'right' }}>{i.tupRead === null ? '—' : num(i.tupRead)}</span>,
        ] }))} />
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>Usage from pg_stat_user_indexes since the last statistics reset.</div>
    </div>
  );
}

function TriggersView({ qp }: { qp: string }) {
  const conn = useConn();
  const q = useQuery({ queryKey: ['table-triggers', conn.id, qp], queryFn: () => api.get<{ triggers: TriggerRow[] }>(`/table/${conn.id}/triggers?${qp}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data!.triggers;
  return (
    <div className="screen" style={{ padding: 14 }}>
      <SectionLabel>Triggers · {rows.length}</SectionLabel>
      <StructTable head={['Name', 'When', 'Events', 'Function', 'State']} template="1.1fr .9fr 1fr 1.1fr .7fr" empty="No triggers on this table."
        rows={rows.map((t) => ({ key: t.name, title: t.def, cells: [
          t.name, t.timing, t.events, t.func,
          <span style={{ color: t.enabled === 'disabled' ? 'var(--state-running)' : undefined }}>{t.enabled}</span>,
        ] }))} />
      {rows.length ? (
        <>
          <div className="label" style={{ margin: '20px 0 8px' }}>Definitions</div>
          <div className="inset" style={{ padding: '8px 12px' }}>
            {rows.map((t) => <pre key={t.name} className="code" style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', margin: '4px 0' }}>{t.def};</pre>)}
          </div>
        </>
      ) : null}
    </div>
  );
}

function DdlView({ qp }: { qp: string }) {
  const conn = useConn();
  const toast = useApp((s) => s.toast);
  const q = useQuery({ queryKey: ['table-ddl', conn.id, qp], queryFn: () => api.get<{ ddl: string }>(`/table/${conn.id}/ddl?${qp}`) });
  const lines = (q.data?.ddl ?? '').replace(/\n$/, '').split('\n');
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <Button size="sm" disabled={!q.data} onClick={() => { void navigator.clipboard?.writeText(q.data!.ddl).then(() => toast('Copied DDL', `${lines.length} lines`, 'info'), (e) => toastError(e, 'Copy failed')); }}>Copy DDL</Button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reconstructed from the catalog · read-only in v1</span>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--bg-inset)', padding: '12px 0' }}>
          {lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 14, padding: '0 14px' }}>
              <span style={{ fontFamily: MONO, fontSize: 13, lineHeight: '20px', color: 'var(--text-muted)', width: 22, textAlign: 'right', userSelect: 'none', flex: 'none' }}>{i + 1}</span>
              <span style={{ fontFamily: MONO, fontSize: 13, lineHeight: '20px', whiteSpace: 'pre', color: /^(create|alter|comment)/.test(l) ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{l || ' '}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

