import { create } from 'zustand';
import type { ConnectionSummary, Me } from '@comb/shared';

export type TabKind =
  | 'table' | 'query' | 'erd' | 'settings' | 'ai' | 'audit' | 'roles' | 'approvals' | 'team' | 'security'
  | 'monitor' | 'topology' | 'backup' | 'migrations' | 'jobs' | 'library' | 'catalog' | 'quality'
  | 'compliance' | 'usage' | 'integrations' | 'deploy';

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  /** Free-form per-tab parameters, e.g. { schema, table } or { sql }. Never secrets. */
  params?: Record<string, any>;
  dirty?: boolean;
}

export interface Toast {
  id: number;
  text: string;
  sub?: string;
  kind: 'success' | 'error' | 'info';
}

export interface ConfirmRequest {
  title: string;
  body: string;
  sql?: string;
  word: string;
  action: string;
  onConfirm: (typed: string) => void | Promise<void>;
  onCancel?: () => void;
}

type Theme = 'dark' | 'light';
type Density = 'compact' | 'comfortable';

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem('comb.' + key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown): void {
  try {
    localStorage.setItem('comb.' + key, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

interface State {
  me: Me | null;
  theme: Theme;
  density: Density;
  conn: ConnectionSummary | null;
  tabs: Tab[];
  active: string | null;
  sidebar: boolean;
  aiOpen: boolean;
  palette: { open: boolean; mode: 'all' | 'switch'; q: string };
  notifOpen: boolean;
  shortcutsOpen: boolean;
  connModal: { mode: 'new' | 'edit'; conn?: ConnectionSummary } | null;
  confirm: ConfirmRequest | null;
  toasts: Toast[];
  ctxMenu: { x: number; y: number; items: Array<{ label: string; onClick: () => void; danger?: boolean; sep?: boolean }> } | null;
  /** Lets screens hand SQL to the AI panel or editor. */
  aiDraft: { text: string; nonce: number } | null;
  editorInsert: { sql: string; mode: 'insert' | 'replace'; nonce: number } | null;

  setMe: (me: Me | null) => void;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setDensity: (d: Density) => void;
  openConnection: (c: ConnectionSummary) => void;
  /** keep: leave the remembered connection so it reopens after the next sign-in. */
  closeConnection: (opts?: { keep?: boolean }) => void;
  openTab: (kind: TabKind, title: string, params?: Record<string, any>, opts?: { unique?: boolean }) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  toast: (text: string, sub?: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  set: (patch: Partial<State>) => void;
}

let toastSeq = 1;
let tabSeq = 1;

/** The connection open in this browser tab, so a reload lands back in the workspace. */
const OPEN_KEY = 'comb.openConnection';
export function rememberedConnection(): string | null {
  try {
    return sessionStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
}
function rememberConnection(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(OPEN_KEY, id);
    else sessionStorage.removeItem(OPEN_KEY);
  } catch {
    /* private mode */
  }
}

function persistTabs(connId: string | undefined, tabs: Tab[], active: string | null): void {
  if (connId) save('tabs.' + connId, { tabs, active });
}

export const useApp = create<State>((set, get) => ({
  me: null,
  theme: load<Theme>('theme', 'dark'),
  density: load<Density>('density', 'comfortable'),
  conn: null,
  tabs: [],
  active: null,
  sidebar: load('sidebar', true),
  aiOpen: load('aiOpen', true),
  palette: { open: false, mode: 'all', q: '' },
  notifOpen: false,
  shortcutsOpen: false,
  connModal: null,
  confirm: null,
  toasts: [],
  ctxMenu: null,
  aiDraft: null,
  editorInsert: null,

  setMe: (me) => set({ me }),
  setTheme: (theme) => {
    save('theme', theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
  setDensity: (density) => {
    save('density', density);
    set({ density });
  },
  openConnection: (c) => {
    const saved = load<{ tabs: Tab[]; active: string | null } | null>('tabs.' + c.id, null);
    const tabs = saved?.tabs?.length
      ? saved.tabs
      : [
          { id: 't' + tabSeq++, kind: 'query' as const, title: 'untitled', params: {} },
          { id: 't' + tabSeq++, kind: 'erd' as const, title: 'public', params: { schema: 'public' } },
        ];
    rememberConnection(c.id);
    set({ conn: c, tabs, active: saved?.active && tabs.some((t) => t.id === saved.active) ? saved.active : tabs[0]?.id ?? null });
  },
  closeConnection: (opts) => {
    if (!opts?.keep) rememberConnection(null);
    set({ conn: null, tabs: [], active: null });
  },
  openTab: (kind, title, params, opts) => {
    const { tabs, conn } = get();
    const unique = opts?.unique ?? !['query', 'table'].includes(kind);
    const existing = tabs.find((t) =>
      t.kind === kind && (unique || (kind === 'table' && t.params?.schema === params?.schema && t.params?.table === params?.table)),
    );
    if (existing) {
      const next = tabs.map((t) => (t.id === existing.id && params ? { ...t, params: { ...t.params, ...params } } : t));
      set({ active: existing.id, tabs: next });
      persistTabs(conn?.id, next, existing.id);
      return existing.id;
    }
    const id = 't' + Date.now().toString(36) + tabSeq++;
    const next = [...tabs, { id, kind, title, params }];
    set({ tabs: next, active: id });
    persistTabs(conn?.id, next, id);
    return id;
  },
  closeTab: (id) => {
    const { tabs, active, conn } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    const nextActive = active === id ? (next[Math.max(0, idx - 1)]?.id ?? null) : active;
    set({ tabs: next, active: nextActive });
    persistTabs(conn?.id, next, nextActive);
  },
  setActive: (id) => {
    set({ active: id });
    persistTabs(get().conn?.id, get().tabs, id);
  },
  updateTab: (id, patch) => {
    const next = get().tabs.map((t) => (t.id === id ? { ...t, ...patch, params: patch.params ? { ...t.params, ...patch.params } : t.params } : t));
    set({ tabs: next });
    persistTabs(get().conn?.id, next, get().active);
  },
  toast: (text, sub, kind = 'success') => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts.slice(-3), { id, text, sub, kind }] });
    setTimeout(() => get().dismissToast(id), 4200);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  set: (patch) => {
    if ('sidebar' in patch) save('sidebar', patch.sidebar);
    if ('aiOpen' in patch) save('aiOpen', patch.aiOpen);
    set(patch);
  },
}));

/** Convenience for screens: the open connection (always set inside the workspace). */
export function useConn(): ConnectionSummary {
  const c = useApp((s) => s.conn);
  if (!c) throw new Error('useConn outside workspace');
  return c;
}

/** Shows a toast for an error thrown by api.* */
export function toastError(e: unknown, title = 'Something went wrong'): void {
  const msg = e instanceof Error ? e.message : String(e);
  useApp.getState().toast(title, msg, 'error');
}
