import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Handle, Position, useReactFlow, useNodesState, useEdgesState,
  type Node, type Edge, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import { api, downloadText } from '../lib/api.ts';
import { useApp, useConn, type Tab } from '../lib/store.ts';
import { useTree } from '../lib/tree.ts';
import { approx } from '../lib/format.ts';
import { Loading, ErrorBox, Empty, MONO, COND } from '../ui/index.tsx';

/*
 * ERD tab: tables of one schema with real FK edges (solid, "1 — ∞") and inferred edges
 * (dashed, "inferred"), laid out by elkjs (layered) and rendered with React Flow.
 */

interface ErdColumn { name: string; type: string; pk: boolean; fk: boolean; nullable: boolean }
interface ErdTable { name: string; kind: string; est: number | null; columns: ErdColumn[] }
interface ErdEdge { id: string; from: string; to: string; fromColumns: string[]; toColumns: string[]; cardinality: '1:1' | '1:n'; inferred: boolean; name: string | null }
interface ErdData { schema: string; tables: ErdTable[]; edges: ErdEdge[]; externalEdges: number; truncated: boolean }

type Detail = 'Keys' | 'Columns' | 'Name only';
const DETAILS: Detail[] = ['Keys', 'Columns', 'Name only'];
const NODE_W = 212;
const HEAD_H = 28;
const ROW_H = 22;

const SHORT: Record<string, string> = {
  bigint: 'int8', integer: 'int4', smallint: 'int2', boolean: 'bool', 'double precision': 'float8', real: 'float4',
  'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp', 'character varying': 'varchar', character: 'char',
};
function shortType(t: string): string {
  const arr = t.endsWith('[]');
  const base = arr ? t.slice(0, -2) : t;
  const m = /^([a-z ]+?)(\(.*\))?$/.exec(base);
  return (m ? (SHORT[m[1]] ?? m[1]) + (m[2] ?? '') : base) + (arr ? '[]' : '');
}

function visibleColumns(t: ErdTable, detail: Detail, inferredCols: Set<string>): ErdColumn[] {
  if (detail === 'Name only') return [];
  if (detail === 'Columns') return t.columns;
  return t.columns.filter((c) => c.pk || c.fk || inferredCols.has(t.name + '.' + c.name));
}

interface TableData extends Record<string, unknown> {
  table: ErdTable;
  cols: ErdColumn[];
  inferredCols: Set<string>;
  dim: boolean;
  focused: boolean;
  onOpen: (name: string) => void;
}

const TableNode = memo(function TableNode({ data }: NodeProps<Node<TableData, 'table'>>) {
  const { table, cols, dim, focused, onOpen, inferredCols } = data;
  return (
    <div style={{ width: NODE_W, background: 'var(--bg-raised)', border: '1px solid ' + (focused ? 'var(--text-secondary)' : 'var(--border-strong)'), borderRadius: 3,
      boxShadow: 'var(--shadow)', cursor: 'pointer', overflow: 'hidden', opacity: dim ? 0.28 : 1, transition: 'opacity .15s' }}>
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', height: HEAD_H, background: 'var(--bg-overlay)', borderBottom: cols.length ? '1px solid var(--border-strong)' : 'none' }}>
        <span className="erd-open nodrag" onClick={(e) => { e.stopPropagation(); onOpen(table.name); }} title={`Open ${table.name}`}
          style={{ fontFamily: MONO, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{table.name}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {table.kind !== 'table' ? table.kind + ' · ' : ''}{table.est === null ? '—' : approx(table.est)}
        </span>
      </div>
      {cols.map((c, i) => {
        const inf = !c.fk && inferredCols.has(table.name + '.' + c.name);
        return (
          <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', height: ROW_H, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
            <span style={{ fontSize: 9, width: 12, flex: 'none', opacity: c.pk || c.fk || inf ? 1 : 0 }} title={c.pk ? 'primary key' : c.fk ? 'foreign key' : inf ? 'inferred reference' : undefined}>
              {c.pk ? '🔑' : c.fk ? '🔗' : inf ? <span style={{ color: 'var(--text-muted)', fontFamily: MONO, fontSize: 11 }}>⋯</span> : ''}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: c.pk ? 500 : 400 }}>{c.name}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 90 }}>{shortType(c.type)}</span>
          </div>
        );
      })}
    </div>
  );
});

const nodeTypes = { table: TableNode };
const elk = new ELK();

async function layout(tables: ErdTable[], edges: ErdEdge[], heights: Map<string, number>): Promise<Map<string, { x: number; y: number }>> {
  const g = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': '60',
    },
    children: tables.map((t) => ({ id: t.name, width: NODE_W, height: heights.get(t.name) ?? HEAD_H })),
    edges: edges.filter((e) => e.from !== e.to).map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  });
  const out = new Map<string, { x: number; y: number }>();
  for (const c of g.children ?? []) out.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  return out;
}

export default function ErdScreen({ tab }: { tab: Tab }) {
  return (
    <ReactFlowProvider>
      <ErdInner tab={tab} />
    </ReactFlowProvider>
  );
}

function ErdInner({ tab }: { tab: Tab }) {
  const conn = useConn();
  const theme = useApp((s) => s.theme);
  const schema: string = tab.params?.schema ?? 'public';
  const [detail, setDetail] = useState<Detail>((tab.params?.detail as Detail) ?? 'Keys');
  const [focus, setFocus] = useState<string | null>(tab.params?.focus ?? null);
  const [layoutSeq, setLayoutSeq] = useState(0);
  const tree = useTree();
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['erd', conn.id, schema],
    queryFn: () => api.get<ErdData>(`/erd/${conn.id}?schema=${encodeURIComponent(schema)}`),
    staleTime: 60_000,
  });
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TableData, 'table'>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const positions = useRef<Map<string, { x: number; y: number }>>(new Map());

  const inferredCols = useMemo(() => new Set((q.data?.edges ?? []).filter((e) => e.inferred).flatMap((e) => e.toColumns.map((c) => e.to + '.' + c))), [q.data]);
  const onOpen = useCallback((name: string) => useApp.getState().openTab('table', name, { schema, table: name }), [schema]);

  const neighbours = useMemo(() => {
    if (!focus || !q.data) return null;
    const s = new Set([focus]);
    for (const e of q.data.edges) {
      if (e.from === focus) s.add(e.to);
      if (e.to === focus) s.add(e.from);
    }
    return s;
  }, [focus, q.data]);

  // Layout when data, detail level or re-layout request changes.
  useEffect(() => {
    const d = q.data;
    if (!d) return;
    let cancelled = false;
    const heights = new Map(d.tables.map((t) => {
      const n = visibleColumns(t, detail, inferredCols).length;
      return [t.name, HEAD_H + 2 + n * ROW_H] as const;
    }));
    const t0 = performance.now();
    void layout(d.tables, d.edges, heights).then((pos) => {
      if (cancelled) return;
      positions.current = pos;
      setNodes(d.tables.map((t) => ({
        id: t.name, type: 'table', position: pos.get(t.name) ?? { x: 0, y: 0 },
        data: { table: t, cols: visibleColumns(t, detail, inferredCols), inferredCols, dim: false, focused: false, onOpen },
      })));
      requestAnimationFrame(() => rf.fitView({ padding: 0.12, duration: layoutSeq ? 250 : 0, maxZoom: 1.1 }));
      if (layoutSeq) useApp.getState().toast('Layout recomputed', `elkjs layered · ${d.tables.length} nodes · ${Math.round(performance.now() - t0)} ms`, 'info');
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, detail, layoutSeq]);

  // Focus dimming and edges.
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, dim: !!neighbours && !neighbours.has(n.id), focused: n.id === focus, onOpen } })));
    const d = q.data;
    if (!d) return;
    setEdges(d.edges.map((e) => {
      const on = !focus || e.from === focus || e.to === focus;
      const stroke = e.inferred ? 'var(--text-muted)' : focus && on ? 'var(--text-secondary)' : 'var(--border-strong)';
      return {
        id: e.id, source: e.from, target: e.to, type: 'smoothstep',
        label: e.inferred ? 'inferred' : e.cardinality === '1:1' ? '1 — 1' : '1 — ∞',
        labelStyle: { fill: e.inferred ? 'var(--text-muted)' : 'var(--text-secondary)', fontFamily: 'var(--mono)', fontSize: 11, opacity: on ? 1 : 0.2 },
        labelBgStyle: { fill: 'var(--bg-inset)', fillOpacity: on ? 1 : 0.2 }, labelBgPadding: [4, 2] as [number, number],
        style: { stroke, strokeWidth: e.inferred ? 1 : 1.5, strokeDasharray: e.inferred ? '4 4' : undefined, opacity: on ? 1 : 0.15 },
        data: { title: e.inferred ? `${e.to}.${e.toColumns.join(', ')} looks like a reference to ${e.from}.${e.fromColumns.join(', ')} (no foreign key)` : `${e.name}: ${e.to}(${e.toColumns.join(', ')}) → ${e.from}(${e.fromColumns.join(', ')})` },
      } as Edge;
    }));
  }, [focus, neighbours, q.data, nodes.length, setNodes, setEdges, onOpen]);

  const setParam = (p: Record<string, unknown>) => useApp.getState().updateTab(tab.id, { params: p });

  const pickSchema = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const names = tree.data?.schemas.map((s) => s.name) ?? ['public'];
    useApp.getState().set({
      ctxMenu: { x: r.left, y: r.bottom + 4, items: names.map((n) => ({ label: (n === schema ? '✓ ' : '   ') + n, onClick: () => {
        setFocus(null);
        useApp.getState().updateTab(tab.id, { title: n, params: { schema: n, focus: null } });
      } })) },
    });
  };

  const exportMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    useApp.getState().set({
      ctxMenu: { x: r.right - 160, y: r.bottom + 4, items: [
        { label: 'Export SVG', onClick: () => void doExport('svg') },
        { label: 'Export PNG', onClick: () => void doExport('png') },
      ] },
    });
  };

  const doExport = async (fmt: 'svg' | 'png') => {
    const d = q.data;
    if (!d || !wrap.current) return;
    const svg = buildSvg(wrap.current, nodes, edges);
    const file = `${conn.name}-${schema}-erd.${fmt}`;
    if (fmt === 'svg') {
      downloadText(file, svg.text, 'image/svg+xml');
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([svg.text], { type: 'image/svg+xml;charset=utf-8' }));
      const img = new Image();
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('Could not render the diagram')); img.src = url; });
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = svg.width * scale;
      canvas.height = svg.height * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => {
        if (!b) return;
        const u = URL.createObjectURL(b);
        const a = document.createElement('a');
        a.href = u;
        a.download = file;
        a.click();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
      }, 'image/png');
    } catch (err) {
      useApp.getState().toast('Export failed', (err as Error).message, 'error');
    }
  };

  const tb: React.CSSProperties = { height: 22, padding: '0 8px', borderRadius: 3, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none', fontSize: 12 };
  const d = q.data;
  const inferredCount = d?.edges.filter((e) => e.inferred).length ?? 0;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 32, flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', fontSize: 12, overflowX: 'auto' }}>
        <button className="hov" onClick={pickSchema} style={{ ...tb, padding: '0 6px' }}>
          Schema: <span style={{ fontFamily: MONO, color: 'var(--text-primary)' }}>{schema} ▾</span>
        </button>
        <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden', height: 22, flex: 'none' }}>
          {DETAILS.map((l, i) => (
            <button key={l} onClick={() => { setDetail(l); setParam({ detail: l }); }}
              style={{ padding: '0 9px', fontSize: 12, fontFamily: COND, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                background: l === detail ? 'var(--bg-selected)' : 'transparent', color: l === detail ? 'var(--text-primary)' : 'var(--text-muted)',
                borderRight: i < DETAILS.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>{l}</button>
          ))}
        </div>
        <button className="hov hov-text" style={tb} onClick={() => setLayoutSeq((x) => x + 1)}>⟳ Re-layout</button>
        <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
          Focus: <span style={{ fontFamily: MONO, color: 'var(--text-primary)' }}>{focus ?? '—'}</span>
          {focus ? <button className="hov hov-text" title="Clear focus" onClick={() => { setFocus(null); setParam({ focus: null }); }} style={{ ...tb, padding: '0 4px', height: 18 }}>✕</button> : null}
        </span>
        <span style={{ flex: 1, minWidth: 8 }} />
        {d ? <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', flex: 'none', fontFamily: MONO, fontSize: 11 }}>{d.tables.length} tables · {d.edges.length - inferredCount} fk{inferredCount ? ` · ${inferredCount} inferred` : ''}</span> : null}
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', whiteSpace: 'nowrap', flex: 'none' }}>
          <span style={{ width: 18, height: 0, borderTop: '1px dashed var(--text-muted)' }} /> inferred
        </span>
        <button className="hov hov-text" style={tb} onClick={exportMenu} disabled={!d}>⤓ Export</button>
      </div>
      <div ref={wrap} className="comb-erd" style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--bg-inset)' }}>
        {q.isLoading ? <Loading label="Reading foreign keys…" /> : q.error ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : d && !d.tables.length ? (
          <Empty title={`No tables in ${schema}`} body="This schema has no tables you can see. Pick another schema." />
        ) : (
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            colorMode={theme} attributionPosition="top-right" minZoom={0.15} maxZoom={2} nodesConnectable={false} edgesFocusable={false}
            onNodeClick={(_, n) => { const next = focus === n.id ? null : n.id; setFocus(next); setParam({ focus: next }); }}
            onPaneClick={() => { if (focus) { setFocus(null); setParam({ focus: null }); } }}
            style={{ background: 'var(--bg-inset)' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--border-strong)" />
            <MiniMap pannable zoomable position="bottom-right" style={{ width: 96, height: 60, margin: 12, background: 'var(--bg-raised)', border: '1px solid var(--border-strong)', borderRadius: 0 }}
              nodeColor={(n) => (neighbours && !neighbours.has(n.id) ? 'var(--border-subtle)' : 'var(--border-strong)')} nodeStrokeWidth={0} maskColor="color-mix(in oklab, var(--bg-inset) 55%, transparent)" />
            <ZoomControls />
          </ReactFlow>
        )}
        {d?.externalEdges ? (
          <div style={{ position: 'absolute', left: 12, bottom: 12, fontSize: 11, color: 'var(--text-muted)', fontFamily: MONO, pointerEvents: 'none' }}>
            {d.externalEdges} foreign key{d.externalEdges > 1 ? 's' : ''} to other schemas not shown{d.truncated ? ' · first 500 tables' : ''}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ZoomControls() {
  const rf = useReactFlow();
  const b: React.CSSProperties = { width: 24, height: 24, color: 'var(--text-secondary)' };
  return (
    <div style={{ position: 'absolute', right: 12 + 96 + 6, bottom: 12, zIndex: 5, display: 'flex', border: '1px solid var(--border-strong)', borderRadius: 3, overflow: 'hidden', background: 'var(--bg-raised)' }}>
      <button className="hov hov-text" style={b} title="Zoom out" onClick={() => void rf.zoomOut({ duration: 150 })}>−</button>
      <button className="hov hov-text" style={{ ...b, borderLeft: '1px solid var(--border-subtle)' }} title="Fit to view" onClick={() => void rf.fitView({ padding: 0.12, duration: 200 })}>⊡</button>
      <button className="hov hov-text" style={{ ...b, borderLeft: '1px solid var(--border-subtle)' }} title="Zoom in" onClick={() => void rf.zoomIn({ duration: 150 })}>+</button>
    </div>
  );
}

// ── Export: a standalone SVG drawn from node positions and the rendered edge paths ──

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSvg(root: HTMLElement, nodes: Array<Node<TableData, 'table'>>, edges: Edge[]): { text: string; width: number; height: number } {
  const cs = getComputedStyle(root);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  const C = {
    bg: v('--bg-inset', '#0B0F13'), raised: v('--bg-raised', '#161C22'), head: v('--bg-overlay', '#1C242B'), strong: v('--border-strong', '#33414C'),
    subtle: v('--border-subtle', '#212B33'), text: v('--text-primary', '#E4EAEF'), muted: v('--text-muted', '#64757F'), sec: v('--text-secondary', '#9AAAB6'),
  };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const h = n.measured?.height ?? HEAD_H + n.data.cols.length * ROW_H;
    minX = Math.min(minX, n.position.x); minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + NODE_W); maxY = Math.max(maxY, n.position.y + h);
  }
  if (!nodes.length) { minX = minY = 0; maxX = maxY = 100; }
  const pad = 30;
  const W = Math.ceil(maxX - minX + pad * 2), H = Math.ceil(maxY - minY + pad * 2);
  const ox = pad - minX, oy = pad - minY;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="IBM Plex Mono, ui-monospace, monospace">`);
  parts.push(`<rect width="100%" height="100%" fill="${C.bg}"/>`);
  parts.push(`<g transform="translate(${ox} ${oy})">`);
  // Edge paths as React Flow rendered them (flow coordinates).
  const byId = new Map(edges.map((e) => [e.id, e]));
  root.querySelectorAll<SVGGElement>('.react-flow__edge').forEach((g) => {
    const id = g.getAttribute('data-id') ?? g.getAttribute('data-testid')?.replace(/^rf__edge-/, '') ?? '';
    const e = byId.get(id);
    const path = g.querySelector('path.react-flow__edge-path');
    if (!e || !path) return;
    const inferred = e.label === 'inferred';
    parts.push(`<path d="${esc(path.getAttribute('d') ?? '')}" fill="none" stroke="${inferred ? C.muted : C.strong}" stroke-width="${inferred ? 1 : 1.5}"${inferred ? ' stroke-dasharray="4 4"' : ''}/>`);
    const lbl = g.querySelector('.react-flow__edge-textwrapper, .react-flow__edge-text');
    const tr = g.querySelector('.react-flow__edge-textwrapper')?.getAttribute('transform');
    const m = tr ? /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(tr) : null;
    if (lbl && m) parts.push(`<text x="${+m[1] + 2}" y="${+m[2] + 12}" font-size="11" fill="${inferred ? C.muted : C.sec}">${esc(String(e.label ?? ''))}</text>`);
  });
  for (const n of nodes) {
    const { x, y } = n.position;
    const cols = n.data.cols;
    const h = HEAD_H + cols.length * ROW_H + (cols.length ? 1 : 0);
    parts.push(`<g transform="translate(${x} ${y})">`);
    parts.push(`<rect width="${NODE_W}" height="${h}" rx="3" fill="${C.raised}" stroke="${C.strong}"/>`);
    parts.push(`<rect x="0.5" y="0.5" width="${NODE_W - 1}" height="${HEAD_H - 1}" rx="3" fill="${C.head}"/>`);
    parts.push(`<text x="8" y="18" font-size="13" font-weight="500" fill="${C.text}">${esc(n.data.table.name)}</text>`);
    parts.push(`<text x="${NODE_W - 8}" y="18" font-size="11" text-anchor="end" fill="${C.muted}">${esc(n.data.table.est === null ? '—' : approx(n.data.table.est))}</text>`);
    cols.forEach((c, i) => {
      const cy = HEAD_H + i * ROW_H;
      parts.push(`<line x1="0" x2="${NODE_W}" y1="${cy}" y2="${cy}" stroke="${i ? C.subtle : C.strong}"/>`);
      const mark = c.pk ? 'PK' : c.fk ? 'FK' : '';
      if (mark) parts.push(`<text x="8" y="${cy + 15}" font-size="8" fill="${C.muted}">${mark}</text>`);
      parts.push(`<text x="26" y="${cy + 15}" font-size="12" fill="${C.text}">${esc(c.name)}</text>`);
      parts.push(`<text x="${NODE_W - 8}" y="${cy + 15}" font-size="11" text-anchor="end" fill="${C.muted}">${esc(shortType(c.type))}</text>`);
    });
    parts.push('</g>');
  }
  parts.push('</g></svg>');
  return { text: parts.join('\n'), width: W, height: H };
}
