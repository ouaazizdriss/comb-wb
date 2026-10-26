import type { FastifyPluginAsync } from 'fastify';

/** Feature modules, each mounted under /api. Loaded lazily so a dev filter can skip some. */
const LOADERS: Record<string, () => Promise<{ default: FastifyPluginAsync }>> = {
  table: () => import('./table.ts'),
  query: () => import('./query.ts'),
  erd: () => import('./erd.ts'),
  ai: () => import('./ai.ts'),
  audit: () => import('./audit.ts'),
  roles: () => import('./roles.ts'),
  approvals: () => import('./approvals.ts'),
  team: () => import('./team.ts'),
  sso: () => import('./sso.ts'),
  security: () => import('./security.ts'),
  monitor: () => import('./monitor.ts'),
  topology: () => import('./topology.ts'),
  backup: () => import('./backup.ts'),
  migrations: () => import('./migrations.ts'),
  jobs: () => import('./jobs.ts'),
  library: () => import('./library.ts'),
  catalog: () => import('./catalog.ts'),
  quality: () => import('./quality.ts'),
  compliance: () => import('./compliance.ts'),
  usage: () => import('./usage.ts'),
  integrations: () => import('./integrations.ts'),
  deploy: () => import('./deploy.ts'),
  settings: () => import('./settings.ts'),
};

/**
 * Production loads every module and fails fast if one is broken.
 * Development may set COMB_MODULES=table,query (comma list) to load only those,
 * so parallel work on other modules cannot break a developer's server.
 */
export async function loadModules(): Promise<FastifyPluginAsync[]> {
  const only = process.env.COMB_MODULES?.split(',').map((s) => s.trim()).filter(Boolean);
  const names = only ? Object.keys(LOADERS).filter((n) => only.includes(n)) : Object.keys(LOADERS);
  const out: FastifyPluginAsync[] = [];
  for (const n of names) out.push((await LOADERS[n]()).default);
  return out;
}
