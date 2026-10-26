import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useQuery } from '@tanstack/react-query';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, highlightSpecialChars,
  placeholder, Decoration, type DecorationSet } from '@codemirror/view';
import { EditorState, Compartment, Prec, StateEffect, StateField } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion } from '@codemirror/autocomplete';
import { sql as sqlLang, PostgreSQL, type SQLNamespace } from '@codemirror/lang-sql';
import { tags as t } from '@lezer/highlight';
import type { QueryResult, ColumnMeta } from '@comb/shared';
import { formatSql, statementAt, splitStatements } from '@comb/shared/src/query.ts';
import { api, ApiError, downloadFrom } from '../lib/api.ts';
import { useApp, useConn, type Tab } from '../lib/store.ts';
import { useStatus } from '../lib/status.ts';
import { useTree } from '../lib/tree.ts';
import { withConfirm } from '../lib/confirm.ts';
import { ms as fmtMs, num, bytes } from '../lib/format.ts';
import { Button, Modal, TextInput, Label, Callout, Dot, TYPE_COLOR, MONO, COND } from '../ui/index.tsx';

/*
 * Query tab: CodeMirror editor, run the statement under the cursor (⌘↵) or everything (⌘⇧↵),
 * stop (⌘.), format, save to library, schema (search_path), explain, results / messages / plan.
 * The server classifies, enforces policy and audits; this screen only sends SQL.
 */

type ResTab = 'Results' | 'Messages' | 'Explain';

interface QErr {
  message: string;
  code?: string;
  position?: number;
  line?: number;
  detail?: string;
  hint?: string;
  /** Absolute 0-based offset in the editor document. */
  abs?: number;
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Alias?: string;
  'Index Name'?: string;
  'Join Type'?: string;
  'Startup Cost'?: number;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Plan Width'?: number;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Filter?: string;
  'Index Cond'?: string;
  'Hash Cond'?: string;
  'Join Filter'?: string;
  'Merge Cond'?: string;
  'Sort Key'?: string[];
  'Group Key'?: string[];
  Plans?: PlanNode[];
}

interface RunState {
  phase: 'idle' | 'running' | 'done' | 'error' | 'approval';
  started?: number;
  /** SQL as sent (including any search_path prefix). */
  sent?: string;
  /** Editor offset of the first character of the user's statement; prefixLen chars of `sent` precede it. */
  base?: number;
  prefixLen?: number;
  result?: QueryResult;
  error?: QErr;
  approvalId?: number;
  ms?: number;
  resTab: ResTab;
  explain?: { phase: 'running' | 'done' | 'error'; plan?: { Plan: PlanNode; 'Planning Time'?: number; 'Execution Time'?: number }; analyze: boolean; error?: string; sql?: string };
}

/** Per-tab run state lives outside the component so results survive switching tabs. */
const useRuns = create<{ runs: Record<string, RunState>; patch: (id: string, p: Partial<RunState>) => void }>((set, get) => ({
  runs: {},
  patch: (id, p) => set({ runs: { ...get().runs, [id]: { ...(get().runs[id] ?? { phase: 'idle', resTab: 'Results' }), ...p } } }),
}));
const IDLE: RunState = { phase: 'idle', resTab: 'Results' };

function quoteIdent(s: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(s) ? s : '"' + s.replace(/"/g, '""') + '"';
}

// ── CodeMirror pieces ─────────────────────────────────────────────

const setErrorMark = StateEffect.define<{ from: number; to: number } | null>();
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorMark)) {
        if (!e.value) deco = Decoration.none;
        else {
          const line = tr.state.doc.lineAt(e.value.from);
          deco = Decoration.set([
            Decoration.line({ class: 'cm-comb-errline' }).range(line.from),
            Decoration.mark({ class: 'cm-comb-error' }).range(e.value.from, Math.max(e.value.to, e.value.from + 1)),
          ], true);
        }
      }
    }
    if (tr.docChanged) deco = Decoration.none;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const combTheme = EditorView.theme({
  '&': { height: '100%', background: 'var(--bg-inset)', color: 'var(--text-primary)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '20px', overflow: 'auto' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--text-primary)' },
  '.cm-line': { padding: '0 14px' },
  '.cm-gutters': { background: 'var(--bg-inset)', border: 'none', color: 'var(--text-muted)' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '42px', padding: '0 10px 0 0', textAlign: 'right', fontSize: '13px' },
  '.cm-gutter.cm-lineNumbers': { paddingTop: '0' },
  '.cm-activeLine': { background: 'color-mix(in oklab, var(--bg-hover) 70%, transparent)' },
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--text-secondary)' },
  '.cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-selectionLayer .cm-selectionBackground': { background: 'var(--bg-selected) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--text-primary)', borderLeftWidth: '1.5px' },
  '.cm-matchingBracket': { background: 'var(--bg-selected)', outline: '1px solid var(--border-strong)' },
  '.cm-selectionMatch': { background: 'color-mix(in oklab, var(--state-info) 16%, transparent)' },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  '.cm-comb-error': { textDecoration: 'underline wavy var(--state-error)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
  '.cm-comb-errline': { background: 'color-mix(in oklab, var(--state-error) 10%, transparent)' },
  '.cm-tooltip': { background: 'var(--bg-overlay)', border: '1px solid var(--border-strong)', borderRadius: '3px', boxShadow: 'var(--shadow)', color: 'var(--text-primary)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12px', maxHeight: '240px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px', lineHeight: '18px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--bg-selected)', color: 'var(--text-primary)' },
  '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal', marginLeft: '10px' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--state-info)' },
  '.cm-completionIcon': { opacity: '0.6' },
  '.cm-panels': { background: 'var(--bg-raised)', color: 'var(--text-primary)', borderColor: 'var(--border-subtle)' },
  '.cm-panel input, .cm-panel button': { color: 'var(--text-primary)', fontSize: '12px' },
  '.cm-searchMatch': { background: 'color-mix(in oklab, var(--state-running) 30%, transparent)' },
});

const combHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--type-temporal)' },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--type-structured)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--type-boolean)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--type-numeric)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.paren, t.bracket, t.separator], color: 'var(--text-secondary)' },
  { tag: [t.special(t.name)], color: 'var(--type-identifier)' },
  { tag: t.variableName, color: 'var(--text-primary)' },
]);

interface CompletionData { schemas: Array<{ name: string; relations: Array<{ name: string; kind: string; columns: Array<[string, string]> }> }> }

function toNamespace(d: CompletionData | undefined): SQLNamespace {
  const ns: Record<string, SQLNamespace> = {};
  for (const s of d?.schemas ?? []) {
    const rels: Record<string, SQLNamespace> = {};
    for (const r of s.relations) {
      rels[r.name] = {
        self: { label: r.name, type: r.kind === 'view' ? 'class' : 'type', detail: r.kind } as Completion,
        children: r.columns.map(([c, ty]) => ({ label: c, type: 'property', detail: ty }) as Completion),
      };
    }
    ns[s.name] = { self: { label: s.name, type: 'namespace', detail: 'schema' } as Completion, children: rels };
  }
  return ns;
}

// ── Screen ────────────────────────────────────────────────────────

export default function QueryScreen({ tab }: { tab: Tab }) {
  const conn = useConn();
  const run = useRuns((s) => s.runs[tab.id]) ?? IDLE;
  const patch = useCallback((p: Partial<RunState>) => useRuns.getState().patch(tab.id, p), [tab.id]);
  const schema: string = tab.params?.schema ?? 'public';
  const tree = useTree();
  const comp = useQuery({
    queryKey: ['query-completions', conn.id],
    queryFn: () => api.get<CompletionData>(`/query/${conn.id}/completions`),
    staleTime: 120_000,
  });
  const [editorPct, setEditorPct] = useState(46);
  const [saveOpen, setSaveOpen] = useState(false);
  const viewRef = useRef<EditorView | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const langComp = useRef(new Compartment());
  const actions = useRef<{ run: (all?: boolean) => void; stop: () => void; explain: (analyze?: boolean) => void }>({ run: () => {}, stop: () => {}, explain: () => {} });

  // Editor lifecycle.
  useEffect(() => {
    const saveTimer = { id: 0 as any };
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: tab.params?.sql ?? '',
        extensions: [
          Prec.highest(keymap.of([
            { key: 'Mod-Enter', run: () => { actions.current.run(false); return true; } },
            { key: 'Mod-Shift-Enter', run: () => { actions.current.run(true); return true; } },
            { key: 'Mod-.', run: () => { actions.current.stop(); return true; } },
            { key: 'Mod-e', run: () => { actions.current.explain(false); return true; } },
          ])),
          lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
          EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
          autocompletion({ icons: false }), highlightActiveLine(), highlightSelectionMatches(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          langComp.current.of(sqlLang({ dialect: PostgreSQL, upperCaseKeywords: false })),
          syntaxHighlighting(combHighlight), combTheme, errorField,
          placeholder('-- ⌘↵ runs the statement under the cursor · ⌘⇧↵ runs everything'),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            clearTimeout(saveTimer.id);
            saveTimer.id = setTimeout(() => useApp.getState().updateTab(tab.id, { params: { sql: u.state.doc.toString() } }), 300);
          }),
        ],
      }),
    });
    viewRef.current = view;
    // Re-apply the error mark of the last run, if any.
    const r = useRuns.getState().runs[tab.id];
    if (r?.phase === 'error' && r.error?.abs !== undefined && r.error.abs <= view.state.doc.length) markError(view, r.error.abs);
    view.focus();
    return () => {
      clearTimeout(saveTimer.id);
      useApp.getState().updateTab(tab.id, { params: { sql: view.state.doc.toString() } });
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // Autocomplete schema: reconfigure when the catalog or the default schema changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: langComp.current.reconfigure(sqlLang({ dialect: PostgreSQL, upperCaseKeywords: false, schema: toNamespace(comp.data), defaultSchema: schema })) });
  }, [comp.data, schema]);

  // AI panel → editor.
  const editorInsert = useApp((s) => s.editorInsert);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !editorInsert || consumedNonces.has(editorInsert.nonce)) return;
    consumedNonces.add(editorInsert.nonce);
    if (editorInsert.mode === 'replace') {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: editorInsert.sql }, selection: { anchor: editorInsert.sql.length } });
    } else {
      const sel = view.state.selection.main;
      const before = sel.from > 0 && view.state.doc.sliceString(sel.from - 1, sel.from) !== '\n' ? '\n' : '';
      const nextCh = view.state.doc.sliceString(sel.to, sel.to + 1);
      const after = nextCh && nextCh !== '\n' ? '\n' : '';
      const text = before + editorInsert.sql + after;
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length - after.length } });
    }
    view.focus();
    useApp.getState().set({ editorInsert: null });
  }, [editorInsert]);

  // Status bar schema.
  useEffect(() => { useStatus.getState().report({ schema }); }, [schema]);

  const prefixFor = (s: string) => (s && s !== 'public' ? `set search_path = ${quoteIdent(s)}, public;\n` : '');

  const pickStatement = (all: boolean): { text: string; base: number } | null => {
    const view = viewRef.current;
    if (!view) return null;
    const doc = view.state.doc.toString();
    const sel = view.state.selection.main;
    if (!all && !sel.empty) {
      const raw = doc.slice(sel.from, sel.to);
      const lead = raw.length - raw.trimStart().length;
      return raw.trim() ? { text: raw.trim(), base: sel.from + lead } : null;
    }
    if (all) {
      const stmts = splitStatements(doc);
      if (!stmts.length) return null;
      return { text: doc.slice(stmts[0].from, stmts[stmts.length - 1].to), base: stmts[0].from };
    }
    const s = statementAt(doc, sel.head);
    return s ? { text: s.text, base: s.from } : null;
  };

  const runSql = async (all: boolean) => {
    const view = viewRef.current;
    if (!view || useRuns.getState().runs[tab.id]?.phase === 'running') return;
    const pick = pickStatement(all);
    if (!pick) {
      useApp.getState().toast('Nothing to run', 'The editor is empty under the cursor.', 'info');
      return;
    }
    const prefix = prefixFor(schema);
    const sent = prefix + pick.text;
    view.dispatch({ effects: setErrorMark.of(null) });
    const started = Date.now();
    patch({ phase: 'running', started, sent, base: pick.base, prefixLen: prefix.length, error: undefined, approvalId: undefined, resTab: 'Results' });
    useStatus.getState().report({ state: 'running' });
    try {
      const r = await withConfirm((confirm) => api.post<QueryResult & { approvalId?: number }>(`/connections/${conn.id}/query`, { sql: sent, confirm }));
      if (!r) {
        patch({ phase: 'idle', started: undefined });
        useStatus.getState().report({ state: 'idle' });
        return;
      }
      if (r.approvalId) {
        patch({ phase: 'approval', approvalId: r.approvalId, ms: Date.now() - started, result: undefined });
        useApp.getState().toast('Sent for approval', `ap-${r.approvalId} · a second person must approve it`, 'info');
        useStatus.getState().report({ state: 'idle', lastQuery: `sent for approval ap-${r.approvalId}` });
        return;
      }
      patch({ phase: 'done', result: r, ms: r.ms });
      const last = r.statements[r.statements.length - 1];
      const rows = r.columns.length ? r.rows.length : last?.rowCount ?? 0;
      useStatus.getState().report({
        state: 'idle', lastQuery: `last query ${fmtMs(r.ms)} / ${num(rows)} rows`, rows: `${num(rows)} rows${r.truncated ? '+' : ''}`, latency: fmtMs(r.ms),
      });
    } catch (e) {
      const b = e instanceof ApiError ? e.body ?? {} : {};
      const err: QErr = { message: e instanceof Error ? e.message : String(e), code: b.code, position: b.position, line: b.line, detail: b.detail, hint: b.hint };
      const st = useRuns.getState().runs[tab.id];
      if (typeof err.position === 'number' && st?.base !== undefined) {
        const rel = err.position - 1 - (st.prefixLen ?? 0);
        if (rel >= 0) {
          err.abs = Math.min(st.base + rel, view.state.doc.length);
          err.line = view.state.doc.lineAt(err.abs).number;
          if (viewRef.current) markError(viewRef.current, err.abs);
        }
      }
      patch({ phase: 'error', error: err, ms: Date.now() - started });
      useStatus.getState().report({ state: 'error', lastQuery: `failed after ${fmtMs(Date.now() - started)}`, latency: fmtMs(Date.now() - started) });
    }
  };

  const stop = async () => {
    try {
      const r = await api.post<{ cancelled: number }>(`/connections/${conn.id}/cancel`, {});
      if (!r.cancelled) useApp.getState().toast('Nothing to stop', 'No statement of yours is running on this connection.', 'info');
    } catch (e) {
      useApp.getState().toast('Stop failed', (e as Error).message, 'error');
    }
  };

  const explain = async (analyze = false) => {
    const pick = pickStatement(false);
    if (!pick) return;
    const inner = pick.text.replace(/;\s*$/, '');
    if (analyze) {
      try {
        const c = await api.post<{ statements: Array<{ kind: string }>; error?: string }>(`/query/${conn.id}/classify`, { sql: inner });
        if (c.error || !c.statements.length || c.statements.some((s) => s.kind !== 'read')) {
          useApp.getState().toast('EXPLAIN ANALYZE not offered', 'It executes the statement, so it is only available for read-only statements.', 'info');
          return;
        }
      } catch (e) {
        useApp.getState().toast('Could not check the statement', (e as Error).message, 'error');
        return;
      }
    }
    const sql = prefixFor(schema) + `explain (${analyze ? 'analyze, buffers, ' : ''}format json) ${inner}`;
    patch({ resTab: 'Explain', explain: { phase: 'running', analyze, sql: inner } });
    try {
      const r = await api.post<QueryResult>(`/connections/${conn.id}/query`, { sql });
      let v: any = r.rows[0]?.[0];
      if (typeof v === 'string') v = JSON.parse(v);
      patch({ explain: { phase: 'done', plan: Array.isArray(v) ? v[0] : v, analyze, sql: inner } });
    } catch (e) {
      patch({ explain: { phase: 'error', error: (e as Error).message, analyze, sql: inner } });
    }
  };

  actions.current = { run: (all) => void runSql(!!all), stop: () => void stop(), explain: (a) => void explain(a) };

  // ⌘↵ etc. also work when focus is outside the editor (results, toolbar).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if ((e.target as HTMLElement | null)?.closest?.('.cm-editor')) return;
      if ((e.target as HTMLElement | null)?.closest?.('[role=dialog]')) return;
      if (e.key === 'Enter') { e.preventDefault(); actions.current.run(e.shiftKey); }
      else if (e.key === '.') { e.preventDefault(); actions.current.stop(); }
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);

  const format = () => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    const whole = sel.empty;
    const src = whole ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
    if (!src.trim()) return;
    const out = formatSql(src);
    const text = whole ? out : out.replace(/\n$/, '');
    view.dispatch({ changes: { from: whole ? 0 : sel.from, to: whole ? view.state.doc.length : sel.to, insert: text } });
    view.focus();
  };

  const pickSchema = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const names = tree.data?.schemas.map((s) => s.name) ?? ['public'];
    useApp.getState().set({
      ctxMenu: { x: r.left, y: r.bottom + 4, items: names.map((n) => ({ label: (n === schema ? '✓ ' : '   ') + n, onClick: () => useApp.getState().updateTab(tab.id, { params: { schema: n } }) })) },
    });
  };

  const explainMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    useApp.getState().set({
      ctxMenu: { x: r.right - 220, y: r.bottom + 4, items: [
        { label: 'Explain (plan only)', onClick: () => void explain(false) },
        { label: 'Explain analyze (runs it; reads only)', onClick: () => void explain(true) },
      ] },
    });
  };

  const fixWithAI = () => {
    const sqlText = run.sent ? run.sent.slice(run.prefixLen ?? 0) : viewRef.current?.state.doc.toString() ?? '';
    useApp.getState().set({ aiDraft: { text: 'Fix this error: ' + (run.error?.message ?? '') + '\n' + sqlText, nonce: Date.now() }, aiOpen: true });
  };

  const exportCsv = async () => {
    if (!run.sent) return;
    try {
      await downloadFrom(`/query/${conn.id}/export`, `${conn.name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`, { sql: run.sent, format: 'csv' });
      useApp.getState().toast('Export started', 'CSV, up to 100,000 rows · recorded in the audit trail', 'success');
    } catch (e) {
      useApp.getState().toast('Export refused', (e as Error).message, 'error');
    }
  };

  // Splitter drag.
  const bodyRef = useRef<HTMLDivElement>(null);
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = bodyRef.current!.getBoundingClientRect();
    const move = (ev: MouseEvent) => setEditorPct(Math.max(15, Math.min(85, ((ev.clientY - box.top) / box.height) * 100)));
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };

  const running = run.phase === 'running';
  const tbBtn: React.CSSProperties = { height: 22, padding: '0 8px', borderRadius: 3, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none' };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 32, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)' }}>
        {running ? (
          <button onClick={() => void stop()} title="Stop ⌘."
            style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 10px', borderRadius: 3, border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', flex: 'none' }}>
            ▢ Stop <span style={{ fontFamily: MONO, opacity: 0.7 }}>⌘.</span>
          </button>
        ) : (
          <button onClick={() => void runSql(false)} title="Run the statement under the cursor ⌘↵ · everything ⌘⇧↵"
            style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 10px', borderRadius: 3, background: 'var(--btn-primary)', color: 'var(--text-inverse)', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', flex: 'none' }}>
            ▷ Run <span style={{ fontFamily: MONO, opacity: 0.6 }}>⌘↵</span>
          </button>
        )}
        <button className="hov hov-text" style={tbBtn} onClick={format} title="Format the selection or the whole editor">⌥ Format</button>
        <button className="hov hov-text" style={tbBtn} onClick={() => setSaveOpen(true)} title="Save to the query library">⤓ Save</button>
        <div style={{ width: 1, height: 16, background: 'var(--border-subtle)', margin: '0 2px' }} />
        <button className="hov hov-text" onClick={pickSchema} title="Schema (sets search_path for the run)"
          style={{ ...tbBtn, fontFamily: MONO }}>{schema} ▾</button>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button className="hov hov-text" style={tbBtn} onClick={() => void explain(false)} title="Explain the statement under the cursor ⌘E">⚡ Explain</button>
          <button className="hov hov-text" style={{ ...tbBtn, padding: '0 5px', fontSize: 9 }} onClick={explainMenu} title="Explain options" aria-label="Explain options">▾</button>
        </div>
      </div>

      <div ref={bodyRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div ref={hostRef} style={{ height: editorPct + '%', flex: 'none', minHeight: 120, background: 'var(--bg-inset)', overflow: 'hidden', position: 'relative' }} />
        <div onMouseDown={startDrag} style={{ height: 5, flex: 'none', background: 'var(--bg-raised)', borderTop: '1px solid var(--border-subtle)', borderBottom: '1px solid var(--border-subtle)', cursor: 'row-resize' }} />
        <Results run={run} patch={patch} onRunAgain={() => void runSql(false)} onFix={fixWithAI} onExport={() => void exportCsv()} />
      </div>
      {saveOpen ? <SaveModal onClose={() => setSaveOpen(false)} sql={viewRef.current?.state.doc.toString() ?? ''} connId={conn.id} tab={tab} /> : null}
    </div>
  );
}

const consumedNonces = new Set<number>();

function markError(view: EditorView, abs: number) {
  const doc = view.state.doc;
  let from = Math.max(0, Math.min(abs, doc.length));
  const line = doc.lineAt(from);
  // Underline the token at the position (word, quoted name or a single char).
  const rest = doc.sliceString(from, line.to);
  const m = /^("(?:[^"]|"")*"|[A-Za-z0-9_$.]+|\S)/.exec(rest);
  let to = from + (m ? m[0].length : 1);
  if (from === line.to && from > line.from) { from -= 1; to = from + 1; }
  view.dispatch({ effects: setErrorMark.of({ from, to: Math.min(to, line.to || to) }), scrollIntoView: true });
}

// ── Results area ──────────────────────────────────────────────────

function Results({ run, patch, onRunAgain, onFix, onExport }: { run: RunState; patch: (p: Partial<RunState>) => void; onRunAgain: () => void; onFix: () => void; onExport: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (run.phase !== 'running') return;
    const id = setInterval(() => tick((x) => x + 1), 100);
    return () => clearInterval(id);
  }, [run.phase]);
  const r = run.result;
  const msgCount = run.phase === 'done' && r ? r.notices.length + r.statements.length : 0;
  const size = useMemo(() => (r ? approxSize(r.rows) : 0), [r]);
  const rowsShown = r ? (r.columns.length ? r.rows.length : r.statements[r.statements.length - 1]?.rowCount ?? 0) : 0;
  const meta = run.phase === 'running' ? `running… ${((Date.now() - (run.started ?? Date.now())) / 1000).toFixed(1)}s`
    : run.phase === 'error' ? `✕ failed · ${fmtMs(run.ms)}`
    : run.phase === 'approval' ? `⧗ sent for approval ap-${run.approvalId}`
    : run.phase === 'done' && r ? `✓ ${num(rowsShown)} ${r.columns.length ? 'rows' : 'affected'}${r.truncated ? '+' : ''} · ${fmtMs(r.ms)}${r.columns.length ? ' · ' + bytes(size) : ''}`
    : 'idle';
  const metaColor = run.phase === 'error' ? 'var(--state-error)' : run.phase === 'running' || run.phase === 'approval' ? 'var(--state-running)' : run.phase === 'done' ? 'var(--state-success)' : 'var(--text-muted)';

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 28, flex: 'none', display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)' }}>
        {(['Results', 'Messages', 'Explain'] as const).map((l) => (
          <button key={l} onClick={() => patch({ resTab: l })}
            style={{ padding: '0 11px', fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
              color: run.resTab === l ? 'var(--text-primary)' : 'var(--text-muted)', borderBottom: '2px solid ' + (run.resTab === l ? 'var(--text-primary)' : 'transparent') }}>
            {l}
            {l === 'Messages' && msgCount > 0 ? <span style={{ marginLeft: 6, fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>{msgCount}</span> : null}
            {l === 'Explain' && run.explain?.phase === 'running' ? <span style={{ marginLeft: 6 }}><Dot color="var(--state-running)" size={6} pulse /></span> : null}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', gap: 10 }}>
          {run.phase === 'done' && r?.columns.length ? (
            <button className="hov hov-text" onClick={onExport} title="Export this query as CSV (re-runs it read-only, up to 100,000 rows)"
              style={{ height: 20, padding: '0 7px', borderRadius: 3, fontSize: 12, color: 'var(--text-secondary)' }}>⤓ CSV</button>
          ) : null}
          <span style={{ fontFamily: MONO, fontSize: 12, whiteSpace: 'nowrap', color: metaColor, display: 'flex', alignItems: 'center', gap: 6 }}>
            {run.phase === 'running' ? <Dot color="var(--state-running)" pulse /> : null}{meta}
          </span>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {run.resTab === 'Results' ? (
          run.phase === 'error' && run.error ? <ErrorPanel err={run.error} onFix={onFix} onRunAgain={onRunAgain} />
          : run.phase === 'approval' ? (
            <div style={{ padding: 16, maxWidth: 640 }}>
              <Callout kind="info" title={`Sent for approval ap-${run.approvalId}`}>
                This connection requires a second person to approve writes. The statement runs once an Admin approves it in Admin → Approvals; you will get a notification.
              </Callout>
            </div>
          )
          : run.phase === 'done' && r ? (
            r.columns.length ? <Grid result={r} /> : (
              <div style={{ padding: '14px 16px', fontFamily: MONO, fontSize: 13, color: 'var(--text-secondary)' }}>
                {r.statements.map((s, i) => <div key={i}>✓ {s.command}{s.rowCount !== null ? ` · ${num(s.rowCount)} rows` : ''} · {fmtMs(s.ms)}</div>)}
                <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12 }}>No rows returned.</div>
              </div>
            )
          )
          : run.phase === 'running' && !r ? <div style={{ flex: 1 }} />
          : run.phase === 'running' && r ? (r.columns.length ? <Grid result={r} /> : <div style={{ flex: 1 }} />)
          : (
            <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 30 }}>
              <div style={{ textAlign: 'center', maxWidth: 320 }}>
                <div style={{ fontSize: 24, lineHeight: '30px', fontWeight: 600, marginBottom: 6 }}>Nothing run yet.</div>
                <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)' }}>Press <span style={{ fontFamily: MONO }}>⌘↵</span> to run the statement under the cursor.</div>
              </div>
            </div>
          )
        ) : run.resTab === 'Messages' ? <Messages run={run} /> : <ExplainView run={run} />}
        {run.phase === 'running' && run.resTab === 'Results' ? <div style={{ position: 'absolute', inset: 0, background: 'var(--bg-base)', opacity: 0.55, animation: 'combpulse 1.6s ease-in-out infinite' }} /> : null}
      </div>
    </div>
  );
}

function approxSize(rows: unknown[][]): number {
  let n = 0;
  for (const r of rows) for (const v of r) n += v === null || v === undefined ? 4 : typeof v === 'object' ? JSON.stringify(v).length : String(v).length + 1;
  return n;
}

function ErrorPanel({ err, onFix, onRunAgain }: { err: QErr; onFix: () => void; onRunAgain: () => void }) {
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--state-error)', fontSize: 14 }}>✕</span>
        <span style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500, color: 'var(--state-error)' }}>Query failed</span>
      </div>
      <div style={{ border: '1px solid var(--border-strong)', borderLeft: '3px solid var(--state-error)', borderRadius: 3, padding: '10px 12px', background: 'var(--bg-raised)' }}>
        <pre style={{ margin: 0, fontFamily: MONO, fontSize: 13, lineHeight: '20px', whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>{err.code && /^[0-9A-Z]{5}$/.test(err.code) ? 'ERROR:  ' : ''}{err.message}</pre>
        {err.detail ? <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>DETAIL: {err.detail}</div> : null}
        {err.hint ? <div style={{ marginTop: 2, fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>HINT: {err.hint}</div> : null}
        <div style={{ display: 'flex', gap: 16, marginTop: 8, fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)' }}>
          {err.code ? <span>{/^[0-9A-Z]{5}$/.test(err.code) ? 'SQLSTATE ' + err.code : err.code}</span> : null}
          {err.abs !== undefined ? <span>position {err.abs + 1}</span> : err.position ? <span>position {err.position}</span> : null}
          {err.line ? <span>line {err.line}</span> : null}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" onClick={onFix}>Fix with AI</Button>
        <Button onClick={onRunAgain}>Run again</Button>
      </div>
    </div>
  );
}

function Messages({ run }: { run: RunState }) {
  const r = run.result;
  const tag = (color: string): React.CSSProperties => ({ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color, width: 64, flex: 'none' });
  if (!r || run.phase === 'idle') {
    return <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text-muted)' }}>{run.phase === 'error' ? 'The run failed; see Results for the error.' : run.phase === 'approval' ? `Sent for approval ap-${run.approvalId}.` : 'No messages yet.'}</div>;
  }
  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto' }}>
      {r.notices.map((n, i) => (
        <div key={'n' + i} style={{ display: 'flex', gap: 10, fontFamily: MONO, fontSize: 13, lineHeight: '20px' }}>
          <span style={tag(n.severity === 'WARNING' ? 'var(--state-running)' : 'var(--state-info)')}>{n.severity}</span>
          <span style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{n.message}</span>
        </div>
      ))}
      {r.statements.map((s, i) => (
        <div key={'s' + i} style={{ display: 'flex', gap: 10, fontFamily: MONO, fontSize: 13, lineHeight: '20px' }}>
          <span style={tag('var(--text-muted)')}>INFO</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            {s.command}{s.rowCount !== null ? ` · ${num(s.rowCount)} ${s.kind === 'read' ? 'rows' : 'rows affected'}` : ''} · {fmtMs(s.ms)}
          </span>
        </div>
      ))}
      {r.truncated ? (
        <div style={{ display: 'flex', gap: 10, fontFamily: MONO, fontSize: 13, lineHeight: '20px' }}>
          <span style={tag('var(--state-running)')}>WARNING</span>
          <span style={{ color: 'var(--text-secondary)' }}>result truncated to {num(r.rows.length)} rows</span>
        </div>
      ) : null}
    </div>
  );
}

// ── Explain ───────────────────────────────────────────────────────

function ExplainView({ run }: { run: RunState }) {
  const ex = run.explain;
  if (!ex) {
    return <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text-secondary)' }}>Press <span style={{ fontFamily: MONO }}>⚡ Explain</span> (⌘E) to see the plan of the statement under the cursor. EXPLAIN ANALYZE, which executes the statement, is offered for read-only statements from the ▾ menu.</div>;
  }
  if (ex.phase === 'running') return <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text-muted)', animation: 'combpulse 1.6s ease-in-out infinite' }}>Planning…</div>;
  if (ex.phase === 'error') {
    return <div style={{ padding: 16, maxWidth: 760 }}><Callout kind="error" title="Explain failed">{ex.error}</Callout></div>;
  }
  const root = ex.plan?.Plan;
  if (!root) return <div style={{ padding: 16, color: 'var(--text-muted)' }}>No plan returned.</div>;
  const rows: Array<{ n: PlanNode; depth: number }> = [];
  const walk = (n: PlanNode, depth: number) => { rows.push({ n, depth }); for (const c of n.Plans ?? []) walk(c, depth + 1); };
  walk(root, 0);
  const metric = (n: PlanNode) => (ex.analyze ? (n['Actual Total Time'] ?? 0) * (n['Actual Loops'] ?? 1) : n['Total Cost'] ?? 0);
  const max = Math.max(1e-9, ...rows.map((r) => metric(r.n)));
  return (
    <div style={{ overflow: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '8px 14px', borderBottom: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)' }}>
        <span>{ex.analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN'}</span>
        <span>total cost {root['Total Cost']?.toFixed(2)}</span>
        <span>est. rows {num(root['Plan Rows'])}</span>
        {ex.plan?.['Planning Time'] !== undefined ? <span>planning {ex.plan['Planning Time'].toFixed(3)} ms</span> : null}
        {ex.plan?.['Execution Time'] !== undefined ? <span>execution {ex.plan['Execution Time'].toFixed(3)} ms</span> : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) 150px 110px 140px', minWidth: 720 }}>
        {['Node', 'Cost', 'Rows', ex.analyze ? 'Actual time' : 'Share of cost'].map((h, i) => (
          <div key={h} className="label" style={{ padding: '6px 10px', textAlign: i ? 'right' : 'left', position: 'sticky', top: 0, background: 'var(--bg-raised)', borderBottom: '1px solid var(--border-subtle)' }}>{h}</div>
        ))}
        {rows.map(({ n, depth }, i) => {
          const share = metric(n) / max;
          const cond = n['Index Cond'] ?? n['Hash Cond'] ?? n['Merge Cond'] ?? n.Filter ?? n['Join Filter'] ?? (n['Sort Key'] ? 'sort ' + n['Sort Key'].join(', ') : n['Group Key'] ? 'group ' + n['Group Key'].join(', ') : '');
          const cell: React.CSSProperties = { padding: '5px 10px', borderBottom: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, textAlign: 'right', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' };
          return (
            <div key={i} style={{ display: 'contents' }}>
              <div style={{ padding: '5px 10px', paddingLeft: 10 + depth * 18, borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                  {depth ? <span style={{ color: 'var(--text-muted)', fontFamily: MONO, fontSize: 12 }}>→</span> : null}
                  <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>{n['Join Type'] && !n['Node Type'].includes(n['Join Type']) ? n['Join Type'] + ' ' : ''}{n['Node Type']}</span>
                  {n['Relation Name'] ? <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>on {n['Relation Name']}{n.Alias && n.Alias !== n['Relation Name'] ? ' ' + n.Alias : ''}</span> : null}
                  {n['Index Name'] ? <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>using {n['Index Name']}</span> : null}
                </div>
                {cond ? <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', paddingLeft: depth ? 18 : 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cond}</div> : null}
              </div>
              <div style={cell}>{n['Startup Cost']?.toFixed(2)}..{n['Total Cost']?.toFixed(2)}</div>
              <div style={cell}>{ex.analyze && n['Actual Rows'] !== undefined ? <span title={`estimated ${n['Plan Rows']}`}>{num(n['Actual Rows'])}<span style={{ color: 'var(--text-muted)' }}> / {num(n['Plan Rows'])}</span></span> : num(n['Plan Rows'])}</div>
              <div style={{ ...cell, gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ex.analyze ? (metric(n)).toFixed(2) + ' ms' : Math.round(share * 100) + '%'}</span>
                <div style={{ width: 60, height: 6, background: 'var(--bg-inset)', borderRadius: 3, overflow: 'hidden', flex: 'none' }}>
                  <span style={{ display: 'block', height: '100%', width: Math.max(2, share * 100) + '%', background: share > 0.6 ? 'var(--state-error)' : share > 0.3 ? 'var(--state-running)' : 'var(--state-info)' }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Results grid (virtualised, read-only) ─────────────────────────

const SHORT: Record<string, string> = {
  bigint: 'int8', integer: 'int4', smallint: 'int2', boolean: 'bool', 'double precision': 'float8', real: 'float4',
  'timestamp with time zone': 'timestamptz', 'timestamp without time zone': 'timestamp', 'time with time zone': 'timetz',
  'time without time zone': 'time', 'character varying': 'varchar', character: 'char',
};
/** Short Postgres type names, as in the mockup (int8, timestamptz, varchar(20)). */
export function shortType(t: string): string {
  const arr = t.endsWith('[]');
  const base = arr ? t.slice(0, -2) : t;
  const m = /^([a-z ]+?)(\(.*\))?$/.exec(base);
  const name = m ? (SHORT[m[1]] ?? m[1]) + (m[2] ?? '') : base;
  return name + (arr ? '[]' : '');
}

function colWidth(c: ColumnMeta, rows: unknown[][], idx: number): number {
  let len = Math.max(c.name.length * 7.6 + 22, shortType(c.type).length * 6.6 + 22);
  const sample = Math.min(rows.length, 200);
  for (let i = 0; i < sample; i++) {
    const v = rows[i][idx];
    const s = v === null || v === undefined ? '␀' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    len = Math.max(len, Math.min(s.length, 60) * 7.8 + 22);
  }
  return Math.round(Math.max(70, Math.min(c.family === 'numeric' ? 160 : 380, len)));
}

function display(v: unknown, c: ColumnMeta): { text: string; color: string } {
  if (v === null || v === undefined) return { text: '␀', color: 'var(--state-null)' };
  if (typeof v === 'object') return { text: JSON.stringify(v), color: TYPE_COLOR.structured };
  if (c.family === 'boolean') return { text: String(v), color: 'var(--text-secondary)' };
  return { text: String(v).replace(/\n/g, '↵'), color: 'var(--text-primary)' };
}

function Grid({ result }: { result: QueryResult }) {
  const density = useApp((s) => s.density);
  const rh = density === 'compact' ? 28 : 34;
  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, h: 400 });
  const widths = useMemo(() => result.columns.map((c, i) => colWidth(c, result.rows, i)), [result]);
  const template = '46px ' + widths.map((w) => w + 'px').join(' ') + ' 1fr';
  const minWidth = 46 + widths.reduce((a, b) => a + b, 0) + 40;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll({ top: el.scrollTop, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const headH = 40;
  const footH = result.truncated ? 64 : 36;
  const first = Math.max(0, Math.floor((scroll.top - headH) / rh) - 10);
  const last = Math.min(result.rows.length, Math.ceil((scroll.top + scroll.h) / rh) + 10);
  const monoV: React.CSSProperties = { fontFamily: MONO, fontSize: 13, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  const copy = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    void navigator.clipboard?.writeText(s);
    useApp.getState().toast('Copied value', s.length > 60 ? s.slice(0, 60) + '…' : s, 'info');
  };
  return (
    <div ref={scroller} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })} style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}>
      <div style={{ minWidth, position: 'relative', height: headH + result.rows.length * rh + footH }}>
        <div style={{ display: 'grid', gridTemplateColumns: template, position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', height: headH }}>
          <div style={{ borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-inset)' }} />
          {result.columns.map((c, i) => (
            <div key={i} style={{ position: 'relative', display: 'flex', borderRight: '1px solid var(--border-subtle)', minWidth: 0 }} title={`${c.name} · ${c.type}`}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 2, background: TYPE_COLOR[c.family] ?? TYPE_COLOR.other }} />
              <div style={{ padding: '4px 8px 4px 10px', display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortType(c.type)}</span>
              </div>
            </div>
          ))}
          <div />
        </div>
        {result.rows.slice(first, last).map((row, k) => {
          const i = first + k;
          return (
            <div key={i} className="row-hover" style={{ display: 'grid', gridTemplateColumns: template, height: rh, borderBottom: '1px solid var(--border-subtle)', position: 'absolute', top: headH + i * rh, left: 0, right: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8, fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-inset)', borderRight: '1px solid var(--border-subtle)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}</div>
              {result.columns.map((c, j) => {
                const d = display(row[j], c);
                return (
                  <div key={j} onDoubleClick={() => copy(row[j])} title={d.text.length > 40 ? d.text.slice(0, 500) : undefined}
                    style={{ display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', overflow: 'hidden', whiteSpace: 'nowrap', minWidth: 0, justifyContent: c.family === 'numeric' ? 'flex-end' : 'flex-start' }}>
                    <span style={{ ...monoV, color: d.color }}>{d.text}</span>
                  </div>
                );
              })}
              <div />
            </div>
          );
        })}
        <div style={{ position: 'absolute', top: headH + result.rows.length * rh, left: 0, right: 0, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {result.truncated ? (
            <div style={{ fontSize: 12, color: 'var(--state-running)', fontFamily: MONO }}>
              ⚠ showing the first {num(result.rows.length)} rows; the result has more. Add a limit, or use ⤓ CSV to export it.
            </div>
          ) : null}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: MONO }}>— no primary key on this result: grid is read-only</div>
        </div>
      </div>
    </div>
  );
}

// ── Save to library ───────────────────────────────────────────────

function SaveModal({ onClose, sql, connId, tab }: { onClose: () => void; sql: string; connId: string; tab: Tab }) {
  const [name, setName] = useState(tab.title && tab.title !== 'untitled' ? tab.title : '');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim() || !sql.trim()) return;
    setBusy(true);
    try {
      await api.post('/library', { name: name.trim(), description: description.trim() || undefined, sql, connectionId: connId });
      useApp.getState().toast('Saved to the library', name.trim(), 'success');
      useApp.getState().updateTab(tab.id, { title: name.trim() });
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        useApp.getState().toast('Query library unavailable', 'This server does not have the library module yet; the query was not saved.', 'error');
        onClose();
      }
      else useApp.getState().toast('Could not save', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Save query" onClose={onClose} width={480}
      footer={<><span className="spacer" /><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !name.trim() || !sql.trim()} onClick={() => void save()}>Save to library</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Label>Name</Label>
          <TextInput mono value={name} onChange={(e) => setName(e.target.value)} placeholder="weekly_active_users" maxLength={120}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Label>Description</Label>
          <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" maxLength={500} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sql.trim() ? `${sql.split('\n').length} lines · saved with this connection` : 'The editor is empty.'}</div>
      </div>
    </Modal>
  );
}
