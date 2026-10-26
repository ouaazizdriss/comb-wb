import { PgBoss } from 'pg-boss';
import { config } from '../config.ts';

/*
 * Background work (scheduled jobs, monitoring samples, PII scans, quality runs, test restores)
 * runs on pg-boss, stored in the metadata database, so no Redis is needed.
 * Modules call registerWorker() at import time; workers start after boss.start().
 */

let boss: PgBoss | null = null;
const workers: Array<{ name: string; handler: (data: any) => Promise<unknown>; cron?: string }> = [];

export function registerWorker<T = unknown>(name: string, handler: (data: T) => Promise<unknown>, cron?: string): void {
  workers.push({ name, handler: handler as (data: any) => Promise<unknown>, cron });
  if (boss) void attach(boss, workers[workers.length - 1]);
}

async function attach(b: PgBoss, w: (typeof workers)[number]): Promise<void> {
  await b.createQueue(w.name).catch(() => {});
  await b.work(w.name, async (jobs: any) => {
    for (const j of Array.isArray(jobs) ? jobs : [jobs]) await w.handler(j.data);
  });
  if (w.cron) await b.schedule(w.name, w.cron, {});
}

export async function startJobs(): Promise<void> {
  boss = new PgBoss({ connectionString: config.COMB_DATABASE_URL, schema: 'pgboss', application_name: 'comb-jobs' } as any);
  boss.on('error', (e: Error) => console.error('jobs error', e.message));
  await boss.start();
  for (const w of workers) await attach(boss, w);
}

export async function enqueue(name: string, data: object = {}, opts: { startAfterSeconds?: number; singletonKey?: string } = {}): Promise<string | null> {
  if (!boss) throw new Error('job system not started');
  await boss.createQueue(name).catch(() => {});
  return boss.send(name, data, { startAfter: opts.startAfterSeconds, singletonKey: opts.singletonKey } as any);
}

/** Creates or replaces a cron schedule (scheduled jobs screen). */
export async function scheduleCron(name: string, cron: string, data: object, tz = 'UTC'): Promise<void> {
  if (!boss) throw new Error('job system not started');
  await boss.createQueue(name).catch(() => {});
  await boss.schedule(name, cron, data, { tz } as any);
}

export async function unscheduleCron(name: string): Promise<void> {
  if (!boss) return;
  await boss.unschedule(name).catch(() => {});
}

export async function stopJobs(): Promise<void> {
  await boss?.stop({ graceful: true, timeout: 5000 } as any).catch(() => {});
}
