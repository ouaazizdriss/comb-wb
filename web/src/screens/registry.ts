import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { Tab, TabKind } from '../lib/store.ts';

export interface ScreenDef {
  icon: string;
  /** Title rendered in mono (object-like tabs) or sans (admin tabs). */
  mono: boolean;
  component: LazyExoticComponent<ComponentType<{ tab: Tab }>>;
}

/** One entry per tab kind. Each screen lives in its own file so modules never collide. */
export const SCREENS: Record<TabKind, ScreenDef> = {
  table: { icon: '▤', mono: true, component: lazy(() => import('./table.tsx')) },
  query: { icon: '⌗', mono: true, component: lazy(() => import('./query.tsx')) },
  erd: { icon: '⬡', mono: true, component: lazy(() => import('./erd.tsx')) },
  settings: { icon: '⚙', mono: false, component: lazy(() => import('./settings.tsx')) },
  ai: { icon: '✳', mono: false, component: lazy(() => import('./ai.tsx')) },
  audit: { icon: '☰', mono: false, component: lazy(() => import('./audit.tsx')) },
  roles: { icon: '⚿', mono: false, component: lazy(() => import('./roles.tsx')) },
  approvals: { icon: '✓', mono: false, component: lazy(() => import('./approvals.tsx')) },
  team: { icon: '◍', mono: false, component: lazy(() => import('./team.tsx')) },
  security: { icon: '⛨', mono: false, component: lazy(() => import('./security.tsx')) },
  monitor: { icon: '◷', mono: false, component: lazy(() => import('./monitor.tsx')) },
  topology: { icon: '⌬', mono: false, component: lazy(() => import('./topology.tsx')) },
  backup: { icon: '⛁', mono: false, component: lazy(() => import('./backup.tsx')) },
  migrations: { icon: '⇅', mono: false, component: lazy(() => import('./migrations.tsx')) },
  jobs: { icon: '◴', mono: false, component: lazy(() => import('./jobs.tsx')) },
  library: { icon: '❂', mono: false, component: lazy(() => import('./library.tsx')) },
  catalog: { icon: '◈', mono: false, component: lazy(() => import('./catalog.tsx')) },
  quality: { icon: '◎', mono: false, component: lazy(() => import('./quality.tsx')) },
  compliance: { icon: '§', mono: false, component: lazy(() => import('./compliance.tsx')) },
  usage: { icon: '≡', mono: false, component: lazy(() => import('./usage.tsx')) },
  integrations: { icon: '⇄', mono: false, component: lazy(() => import('./integrations.tsx')) },
  deploy: { icon: '⌗', mono: false, component: lazy(() => import('./deploy.tsx')) },
};

/** Admin entries in the sidebar, in mockup order: [label, icon, kind, tab title]. */
export const ADMIN_ENTRIES: Array<[string, string, TabKind, string]> = [
  ['Monitoring', '◷', 'monitor', 'Monitoring'],
  ['Approvals', '✓', 'approvals', 'Approvals'],
  ['Cluster topology', '⌬', 'topology', 'Topology'],
  ['Migrations', '⇅', 'migrations', 'Migrations'],
  ['Scheduled jobs', '◴', 'jobs', 'Jobs'],
  ['Query library', '❂', 'library', 'Library'],
  ['Data catalog', '◈', 'catalog', 'Data catalog'],
  ['Data quality', '◎', 'quality', 'Data quality'],
  ['Backups', '⛁', 'backup', 'Backups'],
  ['Audit trail', '☰', 'audit', 'Audit trail'],
  ['Compliance', '§', 'compliance', 'Compliance'],
  ['Usage & cost', '≡', 'usage', 'Usage'],
  ['Roles & privileges', '⚿', 'roles', 'Roles'],
  ['Team & access', '◍', 'team', 'Team & access'],
  ['Security', '⛨', 'security', 'Security'],
  ['Integrations', '⇄', 'integrations', 'Integrations'],
  ['Deployment', '⌗', 'deploy', 'Deployment'],
  ['AI configuration', '✳', 'ai', 'AI configuration'],
];
