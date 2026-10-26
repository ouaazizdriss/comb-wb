import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import { useApp, type TabKind } from '../lib/store.ts';
import { useTree } from '../lib/tree.ts';
import { ago } from '../lib/format.ts';
import { ADMIN_ENTRIES } from '../screens/registry.ts';
import { IDC, Button, Dot } from '../ui/index.tsx';
import { ConnectionModal } from './ConnectionModal.tsx';
import { useConnections, openConnection } from './Launcher.tsx';
import { useNotifications } from './Workspace.tsx';

export function Overlays() {
  const s = useApp();
  return (
    <>
      {s.palette.open ? <Palette /> : null}
      {s.notifOpen && s.conn ? <Notifications /> : null}
      {s.shortcutsOpen ? <Shortcuts /> : null}
      {s.connModal ? <ConnectionModal /> : null}
      {s.confirm ? <Confirm /> : null}
      {s.ctxMenu ? <ContextMenu /> : null}
      <Toasts />
    </>
  );
}

interface PItem { group: string; icon: string; iconColor?: string; label: string; hint: string; run: () => void }

function Palette() {
  const { palette, set, conn, openTab, toggleTheme } = useApp();
  const [q, setQ] = useState(palette.q);
  const [sel, setSel] = useState(0);
  const tree = useTree();
  const conns = useConnections();
  const lib = useQuery({ queryKey: ['library-side'], queryFn: () => api.get<Array<{ id: string; name: string }>>('/library?limit=20'), enabled: !!conn && palette.mode === 'all', retry: false });
  const close = () => set({ palette: { ...palette, open: false } });

  const items = useMemo<PItem[]>(() => {
    const switching = palette.mode === 'switch' || q.startsWith('c:');
    const connItems = (conns.data ?? []).map((c) => ({ group: 'Connections', icon: '▍', iconColor: IDC[c.color], label: c.name, hint: c.env, run: () => openConnection(c) }));
    if (switching || !conn) return connItems;
    const actions: PItem[] = [
      { group: 'Actions', icon: '›', label: 'New query tab', hint: '⌘T', run: () => openTab('query', 'untitled', {}, { unique: false }) },
      { group: 'Actions', icon: '›', label: 'Settings', hint: '⌘,', run: () => openTab('settings', 'Settings') },
      { group: 'Actions', icon: '›', label: 'Toggle theme', hint: '', run: toggleTheme },
      { group: 'Actions', icon: '›', label: 'Toggle AI panel', hint: '⌘I', run: () => set({ aiOpen: !useApp.getState().aiOpen }) },
      { group: 'Actions', icon: '›', label: 'Switch connection', hint: '⌘⇧C', run: () => set({ palette: { open: true, mode: 'switch', q: '' } }) },
      { group: 'Actions', icon: '›', label: 'Entity-relationship diagram', hint: 'ERD', run: () => openTab('erd', 'public', { schema: 'public' }) },
      ...ADMIN_ENTRIES.map(([label, icon, kind, title]) => ({ group: 'Actions', icon, label, hint: '', run: () => openTab(kind as TabKind, title) })),
    ];
    const objs: PItem[] = (tree.data?.schemas ?? []).flatMap((s) => [
      ...s.tables.map((t) => ({ group: 'Tables & views', icon: '▤', label: s.name + '.' + t.name, hint: 'table', run: () => openTab('table', t.name, { schema: s.name, table: t.name }) })),
      ...s.views.map((v) => ({ group: 'Tables & views', icon: '◫', label: s.name + '.' + v.name, hint: v.kind, run: () => openTab('table', v.name, { schema: s.name, table: v.name }) })),
    ]);
    const saved: PItem[] = (lib.data ?? []).map((x) => ({ group: 'Saved queries', icon: '⌗', label: x.name, hint: 'saved query', run: () => openTab('library', 'Library', { sel: x.id }) }));
    if (q.startsWith('>')) return actions;
    if (q.startsWith('@')) return objs;
    if (q.startsWith('#')) return saved;
    return [...actions, ...objs, ...saved, ...connItems.slice(0, 5)];
  }, [palette.mode, q, conns.data, tree.data, lib.data, conn]);

  const needle = q.replace(/^(c:|[>@#])/, '').trim().toLowerCase();
  const filtered = items.filter((i) => !needle || i.label.toLowerCase().includes(needle)).slice(0, 40);
  useEffect(() => setSel(0), [q]);
  const run = (i?: PItem) => { if (!i) return; close(); i.run(); };

  let lastGroup = '';
  return (
    <div onMouseDown={close} style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgb(0 0 0 / 0.35)', display: 'flex', justifyContent: 'center', paddingTop: '12vh' }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ width: 600, maxWidth: 'calc(100vw - 32px)', maxHeight: '64vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-overlay)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42, padding: '0 12px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ color: 'var(--text-muted)' }}>⌕</span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, fontSize: 14 }}
            placeholder={palette.mode === 'switch' ? 'Switch connection…' : 'Search tables, queries, actions…'}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(filtered.length - 1, x + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(filtered[sel]); }
              else if (e.key === 'Escape') close();
            }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>&gt; actions · @ objects · # saved</span>
        </div>
        <div style={{ overflow: 'auto', padding: '4px 0' }}>
          {filtered.map((p, i) => {
            const head = p.group !== lastGroup ? (lastGroup = p.group) : null;
            return (
              <div key={p.group + p.label + i}>
                {head ? <div className="label" style={{ padding: '8px 12px 3px' }}>{head}</div> : null}
                <div onMouseEnter={() => setSel(i)} onClick={() => run(p)}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 12px', height: 28, cursor: 'pointer', background: i === sel ? 'var(--bg-hover)' : undefined }}>
                  <span style={{ width: 12, fontSize: 11, color: p.iconColor ?? 'var(--text-muted)' }}>{p.icon}</span>
                  <span className="mono" style={{ fontSize: 13 }}>{p.label}</span>
                  <span className="spacer" />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.hint}</span>
                </div>
              </div>
            );
          })}
          {!filtered.length ? <div style={{ padding: '20px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No results for “{q}”.</div> : null}
        </div>
      </div>
    </div>
  );
}

function Notifications() {
  const set = useApp((s) => s.set);
  const openTab = useApp((s) => s.openTab);
  const qc = useQueryClient();
  const { data } = useNotifications();
  const list = data ?? [];
  const markRead = async (body: { ids?: number[]; all?: boolean }) => {
    await api.post('/notifications/read', body).catch(() => {});
    await qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return (
    <div onMouseDown={() => set({ notifOpen: false })} style={{ position: 'fixed', inset: 0, zIndex: 85 }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ position: 'fixed', top: 40, right: 60, width: 380, maxHeight: '70vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-overlay)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '9px 11px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontWeight: 600 }}>Notifications</span>
          <span className="spacer" />
          <button className="hov-text" style={{ fontSize: 12, color: 'var(--text-muted)' }} onClick={() => markRead({ all: true })}>Mark all read</button>
        </div>
        <div style={{ overflow: 'auto' }}>
          {list.map((n) => (
            <div key={n.id} className="row-hover" onClick={() => { void markRead({ ids: [n.id] }); set({ notifOpen: false }); if (n.target) openTab(n.target as TabKind, ADMIN_ENTRIES.find((a) => a[2] === n.target)?.[3] ?? n.target); }}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 11px', borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', opacity: n.read ? 0.6 : 1 }}>
              <span style={{ marginTop: 6 }}><Dot size={6} color={n.kind === 'err' ? 'var(--state-error)' : n.kind === 'appr' ? 'var(--state-running)' : 'var(--state-info)'} /></span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, lineHeight: '18px' }}>{n.title}</span>
                <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--text-secondary)' }}>{n.body}</span>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{ago(n.created_at)}</span>
            </div>
          ))}
          {!list.length ? <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>Nothing needs you right now.</div> : null}
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  ['Global', [['⌘K', 'Command palette, objects and actions'], ['⌘⇧C', 'Switch connection'], ['⌘B', 'Toggle the object sidebar'], ['⌘⇧O', 'Filter objects'], ['⌘I', 'Toggle the AI panel'], ['⌘,', 'Settings'], ['⌘/', 'This list']]],
  ['Tabs', [['⌘T', 'New query tab'], ['⌘W', 'Close tab'], ['⌘1…9', 'Jump to tab n'], ['⌃⇥', 'Next tab']]],
  ['Query editor', [['⌘↵', 'Run the statement at the cursor'], ['⌘⇧↵', 'Run everything'], ['⌘.', 'Cancel the running query'], ['⌥⇧F', 'Format'], ['⌘S', 'Save to the library']]],
  ['Data grid', [['Space', 'Value inspector'], ['↵', 'Edit the cell'], ['⌘↵', 'Review staged changes'], ['⌘Z', 'Undo a staged edit'], ['⌫', 'Mark the row for deletion']]],
];

function Shortcuts() {
  const set = useApp((s) => s.set);
  return (
    <div onMouseDown={() => set({ shortcutsOpen: false })} style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgb(0 0 0 / 0.35)', display: 'flex', justifyContent: 'center', paddingTop: '10vh' }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: 'calc(100vw - 32px)', background: 'var(--bg-overlay)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: 'var(--shadow)', alignSelf: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '11px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontWeight: 600 }}>Keyboard</span><span className="spacer" />
          <button className="hov-text" onClick={() => set({ shortcutsOpen: false })} style={{ color: 'var(--text-muted)' }}>✕</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, padding: 14 }}>
          {SHORTCUTS.map(([g, items]) => (
            <div key={g} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="label">{g}</div>
              {items.map(([k, l]) => (
                <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className="mono" style={{ minWidth: 56, fontSize: 12, color: 'var(--text-primary)' }}>{k}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{l}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Confirm() {
  const confirm = useApp((s) => s.confirm)!;
  const set = useApp((s) => s.set);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const armed = typed === confirm.word;
  const close = () => { confirm.onCancel?.(); set({ confirm: null }); };
  const go = async () => {
    if (!armed) return;
    setBusy(true);
    try {
      await confirm.onConfirm(typed);
    } finally {
      setBusy(false);
      set({ confirm: null });
    }
  };
  return (
    <div onMouseDown={close} style={{ position: 'fixed', inset: 0, zIndex: 95, background: 'rgb(0 0 0 / 0.5)', display: 'flex', justifyContent: 'center', paddingTop: '14vh' }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ width: 480, maxWidth: 'calc(100vw - 32px)', alignSelf: 'flex-start', background: 'var(--bg-overlay)', border: '1px solid var(--danger)', borderRadius: 6, boxShadow: 'var(--shadow)' }}>
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--mono)' }}>{confirm.title}</div>
          <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--text-secondary)' }}>{confirm.body}</div>
          {confirm.sql ? <pre className="code inset" style={{ padding: '8px 10px', overflow: 'auto', maxHeight: 160 }}>{confirm.sql}</pre> : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Type <span className="mono" style={{ color: 'var(--text-primary)' }}>{confirm.word}</span> to confirm.</div>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()}
              style={{ height: 30, padding: '0 9px', border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-base)', fontFamily: 'var(--mono)' }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 16px', borderTop: '1px solid var(--border-subtle)' }}>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant={armed ? 'danger' : 'secondary'} disabled={!armed || busy} onClick={go}>{confirm.action}</Button>
        </div>
      </div>
    </div>
  );
}

function ContextMenu() {
  const menu = useApp((s) => s.ctxMenu)!;
  const set = useApp((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div onMouseDown={() => set({ ctxMenu: null })} onContextMenu={(e) => { e.preventDefault(); set({ ctxMenu: null }); }} style={{ position: 'fixed', inset: 0, zIndex: 96 }}>
      <div ref={ref} onMouseDown={(e) => e.stopPropagation()}
        style={{ position: 'fixed', left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 40 - menu.items.length * 26), width: 222,
          background: 'var(--bg-overlay)', border: '1px solid var(--border-strong)', borderRadius: 6, boxShadow: 'var(--shadow)', padding: '4px 0' }}>
        {menu.items.map((i) => (
          <div key={i.label} className="row-hover" onClick={() => { set({ ctxMenu: null }); i.onClick(); }}
            style={{ padding: '0 12px', height: 26, display: 'flex', alignItems: 'center', fontSize: 13, cursor: 'pointer', color: i.danger ? 'var(--danger)' : 'var(--text-primary)',
              ...(i.sep ? { borderTop: '1px solid var(--border-subtle)', marginTop: 4 } : {}) }}>
            {i.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 36, zIndex: 99, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
      {toasts.map((t) => {
        const c = t.kind === 'error' ? 'var(--danger)' : t.kind === 'info' ? 'var(--state-info)' : 'var(--state-success)';
        return (
          <div key={t.id} role="status" style={{ maxWidth: 400, display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', background: 'var(--bg-overlay)', border: '1px solid var(--border-strong)', borderLeft: '3px solid ' + c, borderRadius: 4, boxShadow: 'var(--shadow)' }}>
            <span style={{ color: c, fontSize: 13, paddingTop: 2 }}>{t.kind === 'error' ? '✕' : t.kind === 'info' ? '◆' : '✓'}</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13, lineHeight: '18px', fontWeight: 500 }}>{t.text}</span>
              {t.sub ? <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{t.sub}</span> : null}
            </div>
            <button className="hov-text" onClick={() => dismiss(t.id)} style={{ color: 'var(--text-muted)', fontSize: 12 }}>✕</button>
          </div>
        );
      })}
    </div>
  );
}
