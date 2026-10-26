import { Suspense, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import { useApp, type Tab } from '../lib/store.ts';
import { useStatus } from '../lib/status.ts';
import { useTree } from '../lib/tree.ts';
import { withConfirm } from '../lib/confirm.ts';
import { SCREENS, ADMIN_ENTRIES } from '../screens/registry.ts';
import AiPanel from '../screens/ai-panel.tsx';
import { EnvBadge, ReadOnlyBadge, IDC, Kbd, Loading, IconButton, Dot } from '../ui/index.tsx';

export function Workspace() {
  const conn = useApp((s) => s.conn)!;
  const sidebar = useApp((s) => s.sidebar);
  const aiOpen = useApp((s) => s.aiOpen);
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.active);
  const tab = tabs.find((t) => t.id === active);
  useShortcuts();

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TopBar />
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {sidebar ? <Sidebar /> : null}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <TabBar />
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
            {tab ? (
              <Suspense fallback={<Loading />}>
                <ScreenHost key={conn.id + tab.id} tab={tab} />
              </Suspense>
            ) : (
              <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                <div>No tab open. <Kbd>⌘T</Kbd> opens a query, <Kbd>⌘K</Kbd> finds anything.</div>
              </div>
            )}
          </div>
        </div>
        {aiOpen ? <AiPanel /> : null}
      </div>
      <StatusBar />
    </div>
  );
}

function ScreenHost({ tab }: { tab: Tab }) {
  const Screen = SCREENS[tab.kind]?.component;
  if (!Screen) return null;
  return <Screen tab={tab} />;
}

function TopBar() {
  const conn = useApp((s) => s.conn)!;
  const set = useApp((s) => s.set);
  const aiOpen = useApp((s) => s.aiOpen);
  const toggleTheme = useApp((s) => s.toggleTheme);
  const notifOpen = useApp((s) => s.notifOpen);
  const color = IDC[conn.color] ?? IDC.slate;
  const { data: notifs } = useNotifications();
  const unread = (notifs ?? []).filter((n) => !n.read).length;

  return (
    <div style={{ height: 40, flex: 'none', display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 12, padding: '0 10px', position: 'relative',
      background: `color-mix(in oklab, ${color} 9%, var(--bg-raised))`, borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 3, background: color }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div style={{ width: 3, height: 18, background: color, flex: 'none' }} />
        <button className="hov" onClick={() => set({ palette: { open: true, mode: 'switch', q: '' } })} title="Switch connection ⌘⇧C"
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px', borderRadius: 3 }}>
          <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{conn.name}</span>
          <EnvBadge env={conn.env} />
          {conn.readOnly ? <ReadOnlyBadge /> : null}
          <span style={{ color: 'var(--text-muted)', fontSize: 9 }}>▾</span>
        </button>
      </div>
      <button onClick={() => set({ palette: { open: true, mode: 'all', q: '' } })}
        style={{ display: 'flex', alignItems: 'center', gap: 8, height: 24, padding: '0 10px', border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', color: 'var(--text-muted)', fontSize: 12, minWidth: 220, justifyContent: 'center' }}>
        <span>Search or run a command</span><span className="mono" style={{ fontSize: 11 }}>⌘K</span>
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
        <IconButton title="Theme" onClick={toggleTheme}>◐</IconButton>
        <IconButton title="Notifications" active={notifOpen} onClick={() => set({ notifOpen: !notifOpen })} style={{ position: 'relative' }}>
          <span>◔</span>
          {unread ? (
            <span style={{ position: 'absolute', top: 1, right: 1, minWidth: 13, height: 13, padding: '0 3px', borderRadius: 7, background: 'var(--danger)', color: 'var(--text-inverse)', fontFamily: 'var(--mono)', fontSize: 9, lineHeight: '13px', textAlign: 'center' }}>
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </IconButton>
        <IconButton title="Keyboard shortcuts ⌘/" onClick={() => set({ shortcutsOpen: true })}>⌘</IconButton>
        <IconButton title="Settings ⌘," onClick={() => useApp.getState().openTab('settings', 'Settings')}>⚙</IconButton>
        <IconButton title="Back to connections" onClick={() => useApp.getState().closeConnection()}>⇤</IconButton>
        <button onClick={() => set({ aiOpen: !aiOpen })} title="AI panel ⌘I"
          style={{ height: 24, padding: '0 10px', borderRadius: 3, fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
            border: '1px solid ' + (aiOpen ? 'transparent' : 'var(--border-strong)'), background: aiOpen ? 'var(--btn-primary)' : 'transparent', color: aiOpen ? 'var(--text-inverse)' : 'var(--text-secondary)' }}>
          AI
        </button>
      </div>
    </div>
  );
}

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<Array<{ id: number; kind: string; title: string; body: string; target: string | null; created_at: string; read: boolean }>>('/notifications'),
    refetchInterval: 60_000,
  });
}

interface SideRow {
  key: string;
  depth: number;
  icon: string;
  iconColor?: string;
  label: string;
  labelStyle?: React.CSSProperties;
  meta?: string;
  active?: boolean;
  onClick: () => void;
  onCtx?: (e: React.MouseEvent) => void;
  separated?: boolean;
}

function Sidebar() {
  const [section, setSection] = useState<'objects' | 'queries' | 'history'>('objects');
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ public: true, 'public.tables': true });
  const [adminOpen, setAdminOpen] = useState(true);
  const set = useApp((s) => s.set);
  const openTab = useApp((s) => s.openTab);
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.active);
  const conn = useApp((s) => s.conn)!;
  const cur = tabs.find((t) => t.id === active);
  const tree = useTree();
  const lib = useQuery({ queryKey: ['library-side'], queryFn: () => api.get<Array<{ id: string; name: string }>>('/library?limit=20'), enabled: section === 'queries' });
  const hist = useQuery({ queryKey: ['history-side', conn.id], queryFn: () => api.get<Array<{ id: number; sql: string; ms: number; status: string }>>(`/audit/mine?connectionId=${conn.id}&limit=40`), enabled: section === 'history' });

  const f = filter.toLowerCase();
  const rows: SideRow[] = [];
  const tableCtx = (schema: string, name: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const q = `${quoteIdent(schema)}.${quoteIdent(name)}`;
    set({
      ctxMenu: {
        x: e.clientX, y: e.clientY, items: [
          { label: 'Open data', onClick: () => openTab('table', name, { schema, table: name, sub: 'Data' }) },
          { label: 'Open structure', onClick: () => openTab('table', name, { schema, table: name, sub: 'Structure' }) },
          { label: 'Copy qualified name', onClick: () => { void navigator.clipboard?.writeText(q); useApp.getState().toast('Copied ' + q, undefined, 'info'); } },
          { label: 'Select 100 rows', onClick: () => openTab('query', 'untitled', { sql: `select * from ${q} limit 100;` }, { unique: false }) },
          { label: 'Truncate…', danger: true, sep: true, onClick: () => runDestructive(conn.id, `truncate table ${q};`, 'TRUNCATE') },
          { label: 'Drop…', danger: true, onClick: () => runDestructive(conn.id, `drop table ${q};`, 'DROP') },
        ],
      },
    });
  };

  if (section === 'objects') {
    for (const s of tree.data?.schemas ?? []) {
      const open = expanded[s.name] || !!f;
      rows.push({ key: s.name, depth: 0, icon: open ? '▾' : '▸', label: s.name, labelStyle: { fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 500 },
        onClick: () => setExpanded((x) => ({ ...x, [s.name]: !x[s.name] })) });
      if (!open) continue;
      const groups: Array<[string, Array<{ name: string; meta?: string }>, string]> = [
        ['tables', s.tables.map((t) => ({ name: t.name })), '▤'],
        ['views', s.views.map((v) => ({ name: v.name })), '◫'],
        ['functions', s.functions.map((n) => ({ name: n })), 'ƒ'],
        ['enums', s.enums.map((n) => ({ name: n })), '☰'],
      ];
      for (const [g, items, icon] of groups) {
        const gk = s.name + '.' + g;
        const shown = items.filter((i) => !f || i.name.toLowerCase().includes(f));
        if (f && !shown.length) continue;
        const gopen = expanded[gk] || !!f;
        rows.push({ key: gk, depth: 1, icon: gopen ? '▾' : '▸', label: g.charAt(0).toUpperCase() + g.slice(1), meta: String(items.length),
          labelStyle: { fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-secondary)' },
          onClick: () => setExpanded((x) => ({ ...x, [gk]: !x[gk] })) });
        if (!gopen) continue;
        for (const it of shown) {
          const isRel = g === 'tables' || g === 'views';
          rows.push({
            key: gk + '.' + it.name, depth: 2, icon, label: it.name,
            active: cur?.kind === 'table' && cur.params?.schema === s.name && cur.params?.table === it.name,
            labelStyle: { fontFamily: 'var(--mono)', fontSize: 12 },
            onClick: () => { if (isRel) openTab('table', it.name, { schema: s.name, table: it.name }); },
            onCtx: g === 'tables' ? tableCtx(s.name, it.name) : (e) => e.preventDefault(),
          });
        }
      }
    }
    if (!f) {
      rows.push({ key: 'admin', depth: 0, icon: adminOpen ? '▾' : '▸', label: 'Admin', meta: String(ADMIN_ENTRIES.length), separated: true,
        labelStyle: { fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-secondary)' },
        onClick: () => setAdminOpen((x) => !x) });
      if (adminOpen) {
        for (const [label, icon, kind, title] of ADMIN_ENTRIES) {
          rows.push({ key: 'admin.' + kind, depth: 1, icon, label, active: cur?.kind === kind,
            labelStyle: { fontFamily: 'var(--mono)', fontSize: 12, color: cur?.kind === kind ? 'var(--text-primary)' : 'var(--text-secondary)' },
            onClick: () => openTab(kind, title) });
        }
      }
    }
  } else if (section === 'queries') {
    for (const q of (lib.data ?? []).filter((x) => !f || x.name.toLowerCase().includes(f))) {
      rows.push({ key: 'q' + q.id, depth: 0, icon: '⌗', label: q.name, labelStyle: { fontFamily: 'var(--mono)', fontSize: 12 }, onClick: () => openTab('library', 'Library', { sel: q.id }) });
    }
    rows.push({ key: 'lib', depth: 0, icon: '❂', label: 'Open the full library', separated: true,
      labelStyle: { fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-secondary)' },
      onClick: () => openTab('library', 'Library') });
  } else {
    for (const h of (hist.data ?? []).filter((x) => !f || x.sql.toLowerCase().includes(f))) {
      rows.push({ key: 'h' + h.id, depth: 0, icon: h.status === 'ok' ? '✓' : '✕', iconColor: h.status === 'ok' ? 'var(--state-success)' : 'var(--state-error)', label: h.sql.replace(/\s+/g, ' '),
        meta: h.ms != null ? (h.ms < 1000 ? h.ms + ' ms' : (h.ms / 1000).toFixed(1) + ' s') : '',
        labelStyle: { fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-secondary)' }, onClick: () => openTab('query', 'untitled', { sql: h.sql }, { unique: false }) });
    }
  }

  return (
    <div style={{ width: 248, flex: 'none', background: 'var(--bg-raised)', borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--border-subtle)' }}>
        {(['objects', 'queries', 'history'] as const).map((s) => (
          <button key={s} onClick={() => { setSection(s); setFilter(''); }}
            style={{ flex: 1, fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
              color: section === s ? 'var(--text-primary)' : 'var(--text-muted)', borderBottom: '2px solid ' + (section === s ? IDC[conn.color] : 'transparent') }}>
            {s}
          </button>
        ))}
      </div>
      <div style={{ padding: 8, flex: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 8px', background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 3 }}>
          <input id="comb-tree-filter" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1, fontSize: 12, minWidth: 0 }}
            placeholder={section === 'objects' ? 'filter objects' : section === 'queries' ? 'filter saved queries' : 'search history'} />
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>⌘⇧O</span>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingBottom: 8 }}>
        {section === 'objects' && tree.isLoading ? <Loading label="Reading the catalog…" /> : null}
        {section === 'objects' && tree.error ? <div style={{ padding: 12, fontSize: 12, color: 'var(--state-error)' }}>{(tree.error as Error).message}</div> : null}
        {rows.map((r) => (
          <div key={r.key} onClick={r.onClick} onContextMenu={r.onCtx ?? ((e) => e.preventDefault())} className="row-hover"
            style={{ display: 'flex', alignItems: 'center', gap: 6, height: 24, padding: `0 8px 0 ${8 + r.depth * 13}px`, cursor: 'pointer',
              background: r.active ? 'var(--bg-selected)' : undefined, ...(r.separated ? { marginTop: 6, borderTop: '1px solid var(--border-subtle)' } : {}) }}>
            <span style={{ color: r.iconColor ?? 'var(--text-muted)', fontSize: r.icon === '▾' || r.icon === '▸' ? 9 : 11, width: 11, flex: 'none', textAlign: 'center' }}>{r.icon}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...r.labelStyle }}>{r.label}</span>
            <span className="spacer" />
            {r.meta ? <span style={{ fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', color: 'var(--text-muted)' }}>{r.meta}</span> : null}
          </div>
        ))}
        {filter && rows.length === 0 ? <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No matches for “{filter}”.</div> : null}
      </div>
      <button onClick={() => set({ sidebar: false })} className="hov-text"
        style={{ height: 24, flex: 'none', borderTop: '1px solid var(--border-subtle)', color: 'var(--text-muted)', fontSize: 11, textAlign: 'left', padding: '0 10px' }}>
        ⌘B  collapse
      </button>
    </div>
  );
}

export function quoteIdent(s: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(s) ? s : '"' + s.replace(/"/g, '""') + '"';
}

/** Destructive actions go through the query endpoint, so the server classifies, confirms and audits them. */
export async function runDestructive(connId: string, sql: string, kind: string): Promise<void> {
  try {
    const r = await withConfirm((confirm) => api.post(`/connections/${connId}/query`, { sql, confirm }), { title: `${kind} ${sql.split(' ').slice(-1)[0].replace(/;$/, '')}` });
    if (!r) return;
    if (r.approvalId) useApp.getState().toast('Sent for approval', `ap-${r.approvalId} · a second person must approve it`, 'info');
    else useApp.getState().toast(kind + ' done', `${r.statements?.[0]?.rowCount ?? 0} rows · ${r.ms} ms`);
  } catch (e) {
    useApp.getState().toast(kind + ' — not run', (e as Error).message, 'error');
  }
}

function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.active);
  const conn = useApp((s) => s.conn)!;
  const { setActive, closeTab, openTab } = useApp.getState();
  return (
    <div style={{ height: 32, flex: 'none', display: 'flex', alignItems: 'stretch', background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', overflowX: 'auto' }}>
        {tabs.map((t) => {
          const def = SCREENS[t.kind];
          const on = t.id === active;
          return (
            <div key={t.id} onClick={() => setActive(t.id)} onAuxClick={(e) => e.button === 1 && closeTab(t.id)} className={on ? undefined : 'hov'}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 9px', borderRight: '1px solid var(--border-subtle)', cursor: 'pointer', flex: 'none',
                background: on ? 'var(--bg-base)' : 'transparent', borderTop: '2px solid ' + (on ? IDC[conn.color] : 'transparent'), color: on ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{def?.icon ?? '⚙'}</span>
              <span style={{ fontFamily: def?.mono ? 'var(--mono)' : 'inherit', fontSize: 12, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
              {t.dirty ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-secondary)' }} /> : null}
              <button title="Close tab ⌘W" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} className="hov hov-text"
                style={{ width: 16, height: 16, borderRadius: 2, color: 'var(--text-muted)', fontSize: 11, display: 'grid', placeItems: 'center' }}>✕</button>
            </div>
          );
        })}
      </div>
      <button title="New query tab ⌘T" onClick={() => openTab('query', 'untitled', {}, { unique: false })} className="hov hov-text"
        style={{ width: 32, flex: 'none', color: 'var(--text-muted)', fontSize: 14, borderRight: '1px solid var(--border-subtle)' }}>+</button>
    </div>
  );
}

function StatusBar() {
  const st = useStatus();
  const tree = useTree();
  const conn = useApp((s) => s.conn)!;
  const color = st.state === 'running' ? 'var(--state-running)' : st.state === 'error' ? 'var(--state-error)' : 'var(--state-success)';
  const item: React.CSSProperties = { padding: '0 10px', borderRight: '1px solid var(--border-subtle)', height: '100%', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' };
  return (
    <div style={{ height: 24, flex: 'none', display: 'flex', alignItems: 'center', background: 'var(--bg-raised)', borderTop: '1px solid var(--border-subtle)', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
      <span style={item}><Dot color={color} pulse={st.state === 'running'} />{st.state}</span>
      <span style={item}>{st.schema}</span>
      <span style={item}>PostgreSQL {tree.data?.version ?? '…'}</span>
      <span style={item}>{st.lastQuery}</span>
      <span className="spacer" />
      <span style={{ ...item, borderLeft: '1px solid var(--border-subtle)' }}>{conn.level} access</span>
      <span style={item}>{st.rows}</span>
      <span style={{ ...item, borderRight: 'none' }}>{st.latency}</span>
    </div>
  );
}

function useShortcuts() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const s = useApp.getState();
      const m = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (m && key === 'k') { e.preventDefault(); s.set({ palette: { open: true, mode: 'all', q: '' } }); }
      else if (m && e.shiftKey && key === 'c') { e.preventDefault(); s.set({ palette: { open: true, mode: 'switch', q: '' } }); }
      else if (m && e.shiftKey && key === 'o') { e.preventDefault(); s.set({ sidebar: true }); setTimeout(() => document.getElementById('comb-tree-filter')?.focus(), 0); }
      else if (m && key === 'b') { e.preventDefault(); s.set({ sidebar: !s.sidebar }); }
      else if (m && key === 'i' && !e.shiftKey) { e.preventDefault(); s.set({ aiOpen: !s.aiOpen }); }
      else if (m && key === 't') { e.preventDefault(); s.openTab('query', 'untitled', {}, { unique: false }); }
      else if (m && key === 'w') { if (s.active) { e.preventDefault(); s.closeTab(s.active); } }
      else if (m && key === '/') { e.preventDefault(); s.set({ shortcutsOpen: !s.shortcutsOpen }); }
      else if (m && key === ',') { e.preventDefault(); s.openTab('settings', 'Settings'); }
      else if (m && /^[1-9]$/.test(key)) { const t = s.tabs[Number(key) - 1]; if (t) { e.preventDefault(); s.setActive(t.id); } }
      else if (e.ctrlKey && key === 'tab') {
        e.preventDefault();
        const i = s.tabs.findIndex((t) => t.id === s.active);
        const n = s.tabs[(i + (e.shiftKey ? -1 : 1) + s.tabs.length) % s.tabs.length];
        if (n) s.setActive(n.id);
      } else if (key === 'escape') s.set({ palette: { ...s.palette, open: false }, notifOpen: false, shortcutsOpen: false, ctxMenu: null });
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);
}
