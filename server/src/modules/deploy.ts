import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FLAG_DEFS, type FlagKey, type MemberCounts, type ReleaseRow, type ServiceRow } from '@comb/shared/src/platform.ts';
import { config } from '../config.ts';
import { q, one } from '../db/meta.ts';
import { parse, badRequest } from '../core/http.ts';
import { getSetting, setSetting, hasSecretSetting } from '../core/settings.ts';
import { audit } from '../security/audit.ts';
import { requireRole, userOf } from '../security/authz.ts';
import { installLogCapture, recentLogs } from '../platform/logbuf.ts';

/*
 * Deployment: real health of this process, the job worker, the metadata DB and target pools;
 * member counts; feature flags; release history from CHANGELOG.md.
 * Nothing here makes an outbound call. Upgrades are an ops action: we show the commands.
 */

installLogCapture();

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');
const MIGRATIONS_DIR = path.resolve(here, '..', '..', 'migrations');
const CHANGELOG = path.join(REPO, 'CHANGELOG.md');

// ── Process health sampling ──────────────────────────────────────

const eld = monitorEventLoopDelay({ resolution: 20 });
eld.enable();
let eluPrev: EventLoopUtilization = performance.eventLoopUtilization();
let sample = { elu: 0, eldP99: 0, eldMean: 0, at: Date.now() };
const sampler = setInterval(() => {
  const now = performance.eventLoopUtilization();
  const d = performance.eventLoopUtilization(now, eluPrev);
  eluPrev = now;
  sample = { elu: d.utilization, eldP99: eld.percentile(99) / 1e6, eldMean: eld.mean / 1e6, at: Date.now() };
  eld.reset();
}, 10_000);
sampler.unref();

// ── Flags ────────────────────────────────────────────────────────

const FLAG_KEYS = FLAG_DEFS.map((f) => f.key) as [FlagKey, ...FlagKey[]];

export async function getFlags(): Promise<Record<FlagKey, boolean>> {
  const stored = await getSetting<Record<string, unknown>>('flags', {});
  const out = {} as Record<FlagKey, boolean>;
  for (const f of FLAG_DEFS) out[f.key] = typeof stored?.[f.key] === 'boolean' ? (stored[f.key] as boolean) : f.default;
  return out;
}

/** Server-side flag check for other modules: `if (await isFlagOn('grid.inline_edit')) ...`. Unknown keys are off. */
export async function isFlagOn(key: string): Promise<boolean> {
  const flags = await getFlags();
  return (flags as Record<string, boolean>)[key] === true;
}

// ── Members ──────────────────────────────────────────────────────

async function memberCounts(): Promise<MemberCounts> {
  const r = await one(`select
      count(*) filter (where role <> 'Service' and status = 'active')::int as active,
      count(*) filter (where role <> 'Service' and status = 'invited')::int as invited,
      count(*) filter (where role = 'Service' and status <> 'disabled')::int as service
    from users`);
  return { active: r?.active ?? 0, invited: r?.invited ?? 0, service: r?.service ?? 0 };
}

// ── Migrations ───────────────────────────────────────────────────

async function pendingMigrations(): Promise<string[]> {
  let files: string[] = [];
  try {
    files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
  const done = new Set((await q<{ name: string }>('select name from schema_migrations')).map((r) => r.name));
  return files.filter((f) => !done.has(f));
}

// ── Releases ─────────────────────────────────────────────────────

function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** Parses "## 1.5.0 — 2026-08-12" headings (also "## [1.5.0] - date") and the bullets under them. */
export function parseChangelog(text: string): Array<{ version: string; date: string; notes: string }> {
  const out: Array<{ version: string; date: string; notes: string }> = [];
  let cur: { version: string; date: string; bullets: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\]?\s*(?:[—–-]\s*(\d{4}-\d{2}-\d{2}))?/.exec(line);
    if (h) {
      if (cur) out.push({ version: cur.version, date: cur.date, notes: cur.bullets.join('; ') });
      cur = { version: h[1], date: h[2] ?? '', bullets: [] };
      continue;
    }
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (b && cur) cur.bullets.push(b[1].trim());
  }
  if (cur) out.push({ version: cur.version, date: cur.date, notes: cur.bullets.join('; ') });
  return out;
}

const feedSchema = z.union([
  z.array(z.object({ version: z.string().regex(VERSION), date: z.string().max(20).default(''), notes: z.string().max(500).default('') })).max(200),
  z.object({ releases: z.array(z.object({ version: z.string().regex(VERSION), date: z.string().max(20).default(''), notes: z.string().max(500).default('') })).max(200) }),
]);

function readFeed(): { releases: Array<{ version: string; date: string; notes: string }>; source: string | null; error: string | null } {
  const file = process.env.COMB_RELEASE_FEED;
  if (!file) return { releases: [], source: null, error: null };
  try {
    const st = fs.statSync(file);
    if (st.size > 1024 * 1024) return { releases: [], source: 'file', error: 'Release feed is larger than 1 MB' };
    const parsed = feedSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success) return { releases: [], source: 'file', error: 'Release feed is not in the expected format' };
    return { releases: Array.isArray(parsed.data) ? parsed.data : parsed.data.releases, source: 'file', error: null };
  } catch (e) {
    return { releases: [], source: 'file', error: 'Release feed could not be read: ' + ((e as NodeJS.ErrnoException).code ?? 'error') };
  }
}

function releases(): { rows: ReleaseRow[]; latest: string | null; feed: { configured: boolean; error: string | null } } {
  let log: Array<{ version: string; date: string; notes: string }> = [];
  try {
    log = parseChangelog(fs.readFileSync(CHANGELOG, 'utf8'));
  } catch {
    log = [];
  }
  const feed = readFeed();
  const current = config.COMB_VERSION;
  const byVersion = new Map<string, { version: string; date: string; notes: string }>();
  for (const r of [...feed.releases, ...log]) byVersion.set(r.version, r);
  const rows: ReleaseRow[] = [...byVersion.values()]
    .sort((a, b) => cmpVersion(b.version, a.version))
    .map((r) => ({ ...r, state: cmpVersion(r.version, current) > 0 ? 'available' : cmpVersion(r.version, current) === 0 ? 'current' : 'earlier' }));
  // "Available" only comes from the feed: CHANGELOG lists what shipped with this build.
  const newer = feed.releases.filter((r) => cmpVersion(r.version, current) > 0).sort((a, b) => cmpVersion(b.version, a.version));
  return { rows: rows.slice(0, 30), latest: newer[0]?.version ?? null, feed: { configured: !!feed.source, error: feed.error } };
}

function upgradeCommands(v: string): { docker: string; helm: string } {
  return {
    docker: `# docker compose: pin the new tag, pull, restart (migrations run on start)\nexport COMB_VERSION=${v}\ndocker compose pull comb\ndocker compose up -d comb`,
    helm: `# Kubernetes: rolling upgrade, one API replica at a time\nhelm upgrade comb comb/comb --reuse-values --set image.tag=${v}\nkubectl rollout status deploy/comb-api`,
  };
}

// ── Services ─────────────────────────────────────────────────────

const mb = (n: number) => Math.round(n / 1024 / 1024) + ' MB';

async function services(): Promise<ServiceRow[]> {
  const rows: ServiceRow[] = [];
  const mem = process.memoryUsage();
  const eldLive = eld.percentile(99) / 1e6;
  const p99 = Math.max(sample.eldP99, eldLive || 0);
  rows.push({
    name: 'comb-api',
    role: 'HTTP, sessions, SQL proxy · this process',
    version: config.COMB_VERSION,
    replicas: '1',
    load: Math.min(1, sample.elu),
    loadLabel: Math.round(sample.elu * 100) + '%',
    state: p99 > 500 ? 'degraded' : 'healthy',
    facts: [
      ['pid', String(process.pid)],
      ['node', process.version],
      ['uptime', Math.round(process.uptime()) + ' s'],
      ['rss', mb(mem.rss)],
      ['heap', `${mb(mem.heapUsed)} / ${mb(mem.heapTotal)}`],
      ['event-loop delay p99', p99.toFixed(1) + ' ms'],
      ['event-loop utilisation', (sample.elu * 100).toFixed(1) + '%'],
      ['host load (1 min)', os.loadavg()[0].toFixed(2) + ` on ${os.availableParallelism()} cpu`],
    ],
  });

  try {
    const st = await q<{ state: string; n: number }>(`select state::text, count(*)::int as n from pgboss.job group by 1`);
    const by = Object.fromEntries(st.map((r) => [r.state, r.n])) as Record<string, number>;
    const f24 = await one<{ n: number }>(`select count(*)::int as n from pgboss.job where state = 'failed' and completed_on > now() - interval '24 hours'`);
    const due = await one<{ n: number }>(`select count(*)::int as n from pgboss.job where state in ('created','retry') and start_after <= now()`);
    const queues = await one<{ n: number }>(`select count(distinct name)::int as n from pgboss.job`);
    const dueN = due?.n ?? 0;
    rows.push({
      name: 'comb-worker',
      role: 'pg-boss jobs, deliveries, schedules · in-process',
      version: config.COMB_VERSION,
      replicas: '1',
      load: Math.min(1, dueN / 50),
      loadLabel: `${dueN} due`,
      state: (f24?.n ?? 0) > 0 || dueN > 50 ? 'degraded' : 'healthy',
      facts: [
        ['queues', String(queues?.n ?? 0)],
        ['queued', String((by.created ?? 0) + (by.retry ?? 0))],
        ['due now', String(dueN)],
        ['active', String(by.active ?? 0)],
        ['completed (kept)', String(by.completed ?? 0)],
        ['failed in 24 h', String(f24?.n ?? 0)],
      ],
    });
  } catch (e) {
    rows.push({ name: 'comb-worker', role: 'pg-boss jobs, deliveries, schedules', version: '—', replicas: '0', load: null, loadLabel: '—', state: 'down',
      facts: [['error', (e as Error).message.slice(0, 120)]] });
  }

  try {
    const m = await one(`select current_setting('server_version') as v, pg_database_size(current_database())::bigint as size,
        (select count(*)::int from pg_stat_activity where datname = current_database()) as conns,
        current_setting('max_connections')::int as maxc`);
    const conns = Number(m.conns);
    const maxc = Number(m.maxc);
    rows.push({
      name: 'comb-metadata',
      role: `Postgres ${String(m.v).split(' ')[0]} · connections, trail, catalog`,
      version: String(m.v).split(' ')[0],
      replicas: '1',
      load: maxc ? conns / maxc : null,
      loadLabel: `${conns} / ${maxc} conn`,
      state: conns / maxc > 0.85 ? 'degraded' : 'healthy',
      facts: [['database size', mb(Number(m.size))], ['connections', `${conns} of max ${maxc}`]],
    });
  } catch (e) {
    rows.push({ name: 'comb-metadata', role: 'Postgres', version: '—', replicas: '0', load: null, loadLabel: '—', state: 'down', facts: [['error', (e as Error).message.slice(0, 120)]] });
  }

  const conns = await one<{ n: number }>('select count(*)::int as n from connections');
  let poolFacts: Array<[string, string]> = [['configured connections', String(conns?.n ?? 0)]];
  let load: number | null = null;
  let loadLabel = '—';
  let replicas = '—';
  try {
    const pool: any = await import('../targets/pool.ts');
    if (typeof pool.poolStats === 'function') {
      const ps: Array<{ total: number; idle: number; waiting?: number; max?: number }> = pool.poolStats();
      const total = ps.reduce((a, p) => a + p.total, 0);
      const idle = ps.reduce((a, p) => a + p.idle, 0);
      const max = ps.reduce((a, p) => a + (p.max ?? 5), 0);
      replicas = String(ps.length);
      load = max ? (total - idle) / max : 0;
      loadLabel = `${total - idle} busy / ${total}`;
      poolFacts = [...poolFacts, ['open pools', String(ps.length)], ['clients idle / total', `${idle} / ${total}`]];
    } else {
      poolFacts.push(['pool stats', 'not exposed by this build']);
    }
  } catch {
    poolFacts.push(['pool stats', 'unavailable']);
  }
  rows.push({ name: 'target-pools', role: 'per-connection pg pools, max 5 clients each', version: '—', replicas, load, loadLabel, state: 'healthy', facts: poolFacts });

  const aiKey = await hasSecretSetting('ai.apiKey').catch(() => false);
  const aiCfg = await getSetting<{ model?: string; hardOff?: boolean }>('ai.config', {});
  const flags = await getFlags();
  rows.push({
    name: 'ai',
    role: aiKey ? `Anthropic API · ${aiCfg.model ?? 'default model'}` : 'not configured',
    version: '—',
    replicas: '—',
    load: null,
    loadLabel: '—',
    state: aiKey && flags['ai.panel'] ? 'healthy' : 'off',
    facts: [['API key', aiKey ? 'set' : 'not set'], ['ai.panel flag', flags['ai.panel'] ? 'on' : 'off'], ['row data', aiCfg.hardOff ? 'never sent' : 'per request']],
  });
  return rows;
}

// ── Routes ───────────────────────────────────────────────────────

export default async function deployModule(app: FastifyInstance): Promise<void> {
  app.get('/deploy/overview', async (req) => {
    requireRole(req, 'Admin');
    const pending = await pendingMigrations();
    const size = await one(`select pg_database_size(current_database())::bigint as db,
      coalesce(pg_total_relation_size(to_regclass('public.audit_log')), 0)::bigint as audit`);
    const rel = releases();
    return {
      version: config.COMB_VERSION,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      uptimeS: Math.round(process.uptime()),
      metaDb: { sizeBytes: Number(size.db), auditBytes: Number(size.audit) },
      pendingMigrations: pending,
      latest: rel.latest,
    };
  });

  app.get('/deploy/services', async (req) => {
    requireRole(req, 'Admin');
    return services();
  });

  app.get('/deploy/logs', async (req) => {
    requireRole(req, 'Admin');
    return { lines: recentLogs(), note: 'warn and error lines from this process, redacted, newest last; kept in memory only' };
  });

  // Member counts, for information only: Comb is free and has no seat limit.
  app.get('/deploy/members', async (req) => {
    requireRole(req, 'Admin');
    return memberCounts();
  });

  // Readable by every signed-in user so any module (and the web app) can gate features.
  app.get('/deploy/flags', async (req) => {
    userOf(req);
    return { flags: await getFlags(), defs: FLAG_DEFS };
  });

  app.put('/deploy/flags', async (req) => {
    const user = requireRole(req, 'Admin');
    const body = parse(z.object({ key: z.enum(FLAG_KEYS), on: z.boolean() }), req.body);
    const cur = await getFlags();
    const next = { ...cur, [body.key]: body.on };
    await setSetting('flags', next, user.id);
    await audit({ actorId: user.id, actorLabel: user.email, kind: 'SETTINGS', target: 'flags.' + body.key, status: 'ok', ip: req.ip, detail: { action: 'flag', key: body.key, on: body.on, was: cur[body.key] } });
    return { flags: next, defs: FLAG_DEFS };
  });

  app.get('/deploy/releases', async (req) => {
    requireRole(req, 'Admin');
    const r = releases();
    return { current: config.COMB_VERSION, releases: r.rows, latest: r.latest, feed: r.feed, upgrade: r.latest ? { version: r.latest, ...upgradeCommands(r.latest) } : null };
  });
}
