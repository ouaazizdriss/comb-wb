import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { AI_FEATURES, guessIntent, parseAnswer, type AiFeatureId, type AiIntent, type AiMode } from '@comb/shared/src/ai.ts';
import { api } from '../lib/api.ts';
import { useApp, type Tab } from '../lib/store.ts';
import { useTree } from '../lib/tree.ts';
import { COND, MONO } from '../ui/index.tsx';

/** AI side panel (right). Drafts SQL only; never executes. There is no Run button here on purpose. */

export interface AiStatus {
  hasKey: boolean;
  model: string;
  defaultMode: AiMode;
  hardOff: boolean;
  samples: number;
  features: Record<AiFeatureId, boolean>;
  redactCount: number;
}

export function useAiStatus() {
  return useQuery({ queryKey: ['ai-status'], queryFn: () => api.get<AiStatus>('/ai/status'), staleTime: 30_000 });
}

interface Meta {
  included: string[];
  omitted: number;
  totalTables: number;
  mode: AiMode;
  sampleTables: string[];
  estTokens: number;
}
interface Msg {
  id: number;
  who: 'You' | 'AI';
  text?: string;
  raw?: string;
  sql?: string;
  prose?: string;
  streaming?: boolean;
  error?: string;
  meta?: Meta;
}

// Conversation state outlives the panel being closed and reopened.
const usePanel = create<{
  msgs: Msg[];
  input: string;
  mode: AiMode | null;
  lastDraft: number | null;
  ctrl: AbortController | null;
  set: (p: Partial<{ msgs: Msg[]; input: string; mode: AiMode | null; lastDraft: number | null; ctrl: AbortController | null }>) => void;
  patchLast: (p: Partial<Msg>) => void;
}>((set, get) => ({
  msgs: [],
  input: '',
  mode: null,
  lastDraft: null,
  ctrl: null,
  set: (p) => set(p),
  patchLast: (p) => {
    const msgs = get().msgs.slice();
    msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], ...p };
    set({ msgs });
  },
}));

let msgSeq = 1;
const EXAMPLES = ['count rows in orders by month', 'which users have no orders in 90 days?', 'explain the mrr_by_month view'];
const MODE_LABEL: Record<AiMode, string> = { schema: 'Schema only', samples: '+ samples', none: 'None' };
const MODE_INFO: Record<AiMode, string> = {
  schema: 'Schema only: table and column definitions of the tables in scope, no rows. Plus your prompt and the editor SQL. Nothing else is sent.',
  samples: 'Schema plus a few rows per table, redacted server-side on the configured column patterns. Nothing else is sent.',
  none: 'Only your prompt and the editor SQL. No table names, no columns, no rows.',
};

function activeContext(): { editorSql?: string; openTables: string[]; active?: Tab } {
  const s = useApp.getState();
  const active = s.tabs.find((t) => t.id === s.active);
  const query = active?.kind === 'query' ? active : [...s.tabs].reverse().find((t) => t.kind === 'query');
  const openTables = s.tabs.filter((t) => t.kind === 'table' && t.params?.schema && t.params?.table).map((t) => `${t.params!.schema}.${t.params!.table}`);
  const sql = typeof query?.params?.sql === 'string' ? query.params.sql : undefined;
  return { editorSql: sql?.trim() ? sql : undefined, openTables: [...new Set(openTables)], active };
}

async function csrf(): Promise<string> {
  const me = useApp.getState().me;
  if (me?.csrfToken) return me.csrfToken;
  const fresh = await api.get('/auth/me');
  return fresh.csrfToken ?? '';
}

/** Sends a question and streams the answer (NDJSON over a POST fetch). */
async function ask(question: string, intent: AiIntent, status: AiStatus | undefined): Promise<void> {
  const p = usePanel.getState();
  const conn = useApp.getState().conn;
  if (!conn || !status?.hasKey) return; // no key: the panel shows the configure state, nothing is sent
  p.ctrl?.abort();
  const mode: AiMode = (p.mode ?? status.defaultMode) === 'samples' && status.hardOff ? 'schema' : (p.mode ?? status.defaultMode);
  const history = status.features['F-57']
    ? pairs(p.msgs).slice(-6)
    : [];
  const ctrl = new AbortController();
  p.set({ msgs: [...p.msgs, { id: msgSeq++, who: 'You', text: question }, { id: msgSeq++, who: 'AI', streaming: true, raw: '' }], input: '', ctrl });
  const { editorSql, openTables } = activeContext();
  const body = { connId: conn.id, question, intent, mode, editorSql, openTables, history };
  try {
    let res = await post(body, await csrf(), ctrl.signal);
    if (res.status === 403) {
      // The CSRF token may have rotated (MFA, re-login): fetch it once and retry.
      const me = await api.get('/auth/me');
      useApp.getState().setMe(me);
      res = await post(body, me.csrfToken, ctrl.signal);
    }
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      usePanel.getState().patchLast({ streaming: false, error: j.error ?? `Request failed (${res.status})` });
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        const last = usePanel.getState().msgs.at(-1)!;
        if (ev.type === 'meta') usePanel.getState().patchLast({ meta: ev });
        else if (ev.type === 'delta') {
          const raw = (last.raw ?? '') + ev.text;
          usePanel.getState().patchLast({ raw, ...parseAnswer(raw) });
        } else if (ev.type === 'done') usePanel.getState().patchLast({ sql: ev.sql, prose: ev.prose, streaming: false });
        else if (ev.type === 'error') usePanel.getState().patchLast({ streaming: false, error: ev.error });
      }
    }
    usePanel.getState().patchLast({ streaming: false });
  } catch (e) {
    usePanel.getState().patchLast({ streaming: false, error: ctrl.signal.aborted ? 'Stopped.' : (e as Error).message });
  } finally {
    if (usePanel.getState().ctrl === ctrl) usePanel.getState().set({ ctrl: null });
  }
}

function post(body: unknown, token: string, signal: AbortSignal): Promise<Response> {
  return fetch('/api/ai/ask', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', 'x-comb-csrf': token },
    body: JSON.stringify(body),
  });
}

/** Previous question/answer pairs for follow-up context (F-57). */
function pairs(msgs: Msg[]): Array<{ q: string; a: string }> {
  const out: Array<{ q: string; a: string }> = [];
  for (let i = 0; i + 1 < msgs.length; i++) {
    if (msgs[i].who === 'You' && msgs[i + 1].who === 'AI' && !msgs[i + 1].streaming && !msgs[i + 1].error) {
      out.push({ q: msgs[i].text ?? '', a: msgs[i + 1].raw ?? '' });
    }
  }
  return out;
}

function toEditor(sql: string, mode: 'insert' | 'replace'): void {
  const s = useApp.getState();
  const active = s.tabs.find((t) => t.id === s.active);
  if (active?.kind === 'query') {
    s.set({ editorInsert: { sql, mode, nonce: Date.now() } });
  } else {
    const q = [...s.tabs].reverse().find((t) => t.kind === 'query');
    if (q) {
      s.setActive(q.id);
      setTimeout(() => useApp.getState().set({ editorInsert: { sql, mode, nonce: Date.now() } }), 60);
    } else {
      s.openTab('query', 'untitled', { sql }, { unique: false });
    }
  }
  if (mode === 'insert') s.toast('Inserted at cursor', 'Nothing ran — press ⌘↵ when you are ready.', 'info');
  else s.toast('Editor replaced', 'Nothing ran — press ⌘↵ when you are ready.', 'info');
}

export default function AiPanel() {
  const status = useAiStatus();
  const tree = useTree();
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.active);
  const aiDraft = useApp((s) => s.aiDraft);
  const { msgs, input, mode: chosen, ctrl } = usePanel();
  const st = status.data;
  const mode: AiMode = chosen ?? st?.defaultMode ?? 'schema';
  const effMode: AiMode = mode === 'samples' && st?.hardOff ? 'schema' : mode;
  const listRef = useRef<HTMLDivElement>(null);
  const [showInfo, setShowInfo] = useState(false);

  // "Fix with AI" and friends: prefill and send when a new draft arrives.
  useEffect(() => {
    if (!aiDraft || aiDraft.nonce === usePanel.getState().lastDraft) return;
    if (!st) return; // wait for status so we know whether a key exists
    usePanel.getState().set({ lastDraft: aiDraft.nonce });
    if (st.hasKey) void ask(aiDraft.text, guessIntent(aiDraft.text), st);
    else usePanel.getState().set({ input: aiDraft.text });
  }, [aiDraft, st]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs]);

  const schemas = tree.data?.schemas ?? [];
  const withTables = schemas.filter((s) => s.tables.length || s.views.length);
  const tableCount = schemas.reduce((n, s) => n + s.tables.length, 0);
  const scopeName = withTables.length === 0 ? '—' : withTables.length === 1 ? withTables[0].name
    : (withTables.find((s) => s.name === 'public')?.name ?? withTables[0].name) + ` +${withTables.length - 1}`;
  const ctxLabel = tree.isLoading ? 'reading catalog…' : `${scopeName} · ${tableCount} table${tableCount === 1 ? '' : 's'}`;

  const cur = tabs.find((t) => t.id === active);
  const featOn = (intent: AiIntent) => {
    const f = AI_FEATURES.find((x) => x.intent === intent);
    return !f || !!st?.features[f.id];
  };
  const chips: Array<{ label: string; q: string; intent: AiIntent }> = cur?.kind === 'table'
    ? [
        { label: 'Describe this table', q: `Describe the table ${cur.params?.schema}.${cur.params?.table}: what each column holds and how it relates to other tables.`, intent: 'explain' },
        { label: 'Find anomalies', q: `Write a query that finds anomalies in ${cur.params?.schema}.${cur.params?.table} (nulls where unexpected, duplicates, outliers).`, intent: 'sql' },
      ]
    : [
        { label: 'Explain this query', q: 'Explain the query in the editor.', intent: 'explain' },
        { label: 'Optimise', q: 'Optimise the query in the editor and suggest indexes if they help.', intent: 'optimise' },
      ];
  const shownChips = chips.filter((c) => featOn(c.intent));

  const streaming = !!ctrl;
  const canSend = !!st?.hasKey && !!input.trim() && !streaming;
  const send = () => {
    const text = usePanel.getState().input.trim();
    if (!text || !st?.hasKey || usePanel.getState().ctrl) return;
    const intent = guessIntent(text);
    void ask(text, featOn(intent) ? intent : 'sql', st);
  };
  const close = () => useApp.getState().set({ aiOpen: false });
  const clear = () => {
    usePanel.getState().ctrl?.abort();
    usePanel.getState().set({ msgs: [], ctrl: null });
  };
  const openSettings = () => useApp.getState().openTab('settings', 'Settings');

  return (
    <div style={{ width: 344, flex: 'none', background: 'var(--bg-raised)', borderLeft: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>AI</span>
        {st ? <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.model}</span> : null}
        <span className="spacer" />
        <button onClick={clear} title="Clear conversation" aria-label="Clear conversation" className="hov-text" style={{ color: 'var(--text-muted)', fontSize: 13 }}>⋯</button>
        <button onClick={close} title="Close panel ⌘I" aria-label="Close AI panel" className="hov-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>✕</button>
      </div>

      <div style={{ flex: 'none', padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Context: <span style={{ fontFamily: MONO, color: 'var(--text-secondary)' }}>{effMode === 'none' ? 'none' : ctxLabel}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div role="radiogroup" aria-label="Context mode" style={{ display: 'flex', border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden', height: 22, flex: 1 }}>
            {(['schema', 'samples', 'none'] as const).map((m, i) => {
              const disabled = m === 'samples' && !!st?.hardOff;
              const on = effMode === m;
              return (
                <button key={m} role="radio" aria-checked={on} disabled={disabled}
                  title={disabled ? 'Disabled by an admin: “Never send row data” is on.' : MODE_INFO[m]}
                  onClick={() => usePanel.getState().set({ mode: m })}
                  style={{ flex: 1, padding: '0 6px', fontSize: 11, fontFamily: COND, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                    background: on ? 'var(--bg-selected)' : 'transparent', color: on ? 'var(--text-primary)' : 'var(--text-muted)',
                    borderRight: i < 2 ? '1px solid var(--border-subtle)' : 'none', textDecoration: disabled ? 'line-through' : undefined }}>
                  {MODE_LABEL[m]}
                </button>
              );
            })}
          </div>
          <button onClick={() => setShowInfo((x) => !x)} title={MODE_INFO[effMode]} aria-label="What is sent" className="hov-text" style={{ color: 'var(--text-muted)', fontSize: 12 }}>ⓘ</button>
        </div>
        {showInfo ? <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--text-secondary)' }}>{MODE_INFO[effMode]} The model drafts; it cannot run anything.</div> : null}
        {effMode === 'samples' && st ? (
          <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--state-running)' }}>
            {st.samples} rows per table will be sent, redacted on {st.redactCount} column pattern{st.redactCount === 1 ? '' : 's'}.
          </div>
        ) : null}
        {st?.hardOff ? <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--text-muted)' }}>Row data is off for this workspace — samples are disabled.</div> : null}
      </div>

      <div ref={listRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {st && !st.hasKey ? (
          <div style={{ border: '1px solid var(--border-strong)', borderLeft: '3px solid var(--state-error)', borderRadius: 3, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 13, lineHeight: '18px', fontWeight: 500 }}>No API key configured</div>
            <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--text-secondary)' }}>Add one in Settings → AI. Nothing is sent until you do.</div>
            <button onClick={openSettings} className="hov" style={{ alignSelf: 'flex-start', height: 22, padding: '0 8px', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 12 }}>Open Settings</button>
          </div>
        ) : null}
        {msgs.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)' }}>
              Ask about <span style={{ fontFamily: MONO, color: 'var(--text-primary)' }}>{scopeName === '—' ? 'this database' : scopeName.split(' ')[0]}</span>. Answers arrive as SQL you can insert — nothing runs on its own.
            </div>
            {EXAMPLES.map((e) => (
              <button key={e} disabled={!st?.hasKey} onClick={() => st && void ask(e, guessIntent(e), st)} className="hov hov-text"
                style={{ textAlign: 'left', padding: '7px 9px', border: '1px solid var(--border-subtle)', borderRadius: 3, fontSize: 13, lineHeight: '18px', color: 'var(--text-secondary)' }}>
                {e}
              </button>
            ))}
          </div>
        ) : null}
        {msgs.map((m) => <Message key={m.id} m={m} />)}
      </div>

      <div style={{ flex: 'none', padding: '8px 10px', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {shownChips.length ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {shownChips.map((c) => (
              <button key={c.label} disabled={!st?.hasKey || streaming} onClick={() => st && void ask(c.q, c.intent, st)} className="hov-text"
                style={{ height: 20, padding: '0 7px', border: '1px solid var(--border-subtle)', borderRadius: 3, fontSize: 11, color: 'var(--text-secondary)' }}>
                {c.label}
              </button>
            ))}
          </div>
        ) : null}
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-base)', padding: '7px 9px' }}>
          <textarea
            value={input}
            aria-label="Ask the AI"
            onChange={(e) => usePanel.getState().set({ input: e.target.value })}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }}
            placeholder={st?.hasKey === false ? 'Add an API key in Settings → AI first' : 'Ask about this database…'}
            style={{ width: '100%', height: 44, resize: 'none', fontSize: 13, lineHeight: '18px', background: 'transparent', display: 'block' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
          <span>{MODE_LABEL[effMode] === '+ samples' ? `Schema + ${st?.samples ?? 5} sample rows` : MODE_LABEL[effMode]} · <span style={{ fontFamily: MONO }}>⌘↵</span> to send</span>
          {streaming ? (
            <button onClick={() => usePanel.getState().ctrl?.abort()} style={{ height: 20, padding: '0 8px', borderRadius: 3, border: '1px solid var(--border-strong)', fontSize: 11 }}>Stop</button>
          ) : (
            <button onClick={send} disabled={!canSend} style={{ height: 20, padding: '0 8px', borderRadius: 3, background: 'var(--btn-primary)', color: 'var(--text-inverse)', fontSize: 11, fontWeight: 500 }}>Send</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Message({ m }: { m: Msg }) {
  const [showTables, setShowTables] = useState(false);
  const btn: React.CSSProperties = { height: 22, padding: '0 8px', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 12 };
  const copy = (sql: string) => {
    void navigator.clipboard?.writeText(sql).then(
      () => useApp.getState().toast('Copied to clipboard', undefined, 'info'),
      () => useApp.getState().toast('Could not copy', 'The browser refused clipboard access.', 'error'),
    );
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="label">{m.who}</div>
      {m.who === 'You' ? <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</div> : null}
      {m.sql ? (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', padding: '8px 10px', overflow: 'auto' }}>
          <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: '18px', whiteSpace: 'pre' }}>{m.sql}</pre>
        </div>
      ) : null}
      {m.sql && !m.streaming ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="hov" style={btn} onClick={() => toEditor(m.sql!, 'insert')}>Insert at cursor</button>
          <button className="hov" style={btn} onClick={() => toEditor(m.sql!, 'replace')}>Replace editor</button>
          <button className="hov" style={btn} onClick={() => copy(m.sql!)}>Copy</button>
        </div>
      ) : null}
      {m.prose ? <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><Prose text={m.prose} /></div> : null}
      {m.streaming ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--state-running)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--state-running)', animation: 'combpulse 1.6s ease-in-out infinite' }} /> streaming…
        </div>
      ) : null}
      {m.error ? <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--state-error)' }}>✕ {m.error}</div> : null}
      {m.meta ? (
        <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--text-muted)' }}>
          {m.meta.mode === 'none' ? 'Sent without schema context.' : (
            <>
              <button onClick={() => setShowTables((x) => !x)} className="hov-text" style={{ color: 'var(--text-muted)', fontSize: 11, textDecoration: 'underline dotted' }}>
                Context: {m.meta.included.length} of {m.meta.totalTables} tables
              </button>
              {m.meta.omitted ? ` · ${m.meta.omitted} left out over the token budget` : ''}
              {m.meta.sampleTables.length ? ` · samples from ${m.meta.sampleTables.length}` : ''}
              {` · ≈${(m.meta.estTokens / 1000).toFixed(1)}k tokens`}
              {showTables ? <div style={{ fontFamily: MONO, marginTop: 4, overflowWrap: 'anywhere' }}>{m.meta.included.join(', ')}</div> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Renders `inline code` spans in mono; everything else as plain text (no HTML injection). */
function Prose({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return <>{parts.map((p, i) => (p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <span key={i} style={{ fontFamily: MONO, fontSize: 13, color: 'var(--text-primary)' }}>{p.slice(1, -1)}</span> : p))}</>;
}
