import { q } from '../db/meta.ts';

/*
 * In-process event bus. Modules publish domain events (job.failed, approval.requested, ...);
 * the integrations module subscribes and delivers them to Slack/webhooks.
 * Payloads must carry ids and counts only, never row values.
 */

export type CombEvent =
  | 'job.failed'
  | 'job.succeeded'
  | 'query.blocked'
  | 'approval.requested'
  | 'approval.decided'
  | 'migration.applied'
  | 'monitor.critical'
  | 'backup.completed'
  | 'dq.failed'
  | 'security.alert';

type Handler = (event: CombEvent, payload: Record<string, string | number | boolean | null>) => void | Promise<void>;

const handlers: Handler[] = [];

export function onEvent(h: Handler): void {
  handlers.push(h);
}

type Payload = Record<string, string | number | boolean | null>;

/** Enforces "ids and counts only": scalars only, strings capped at 200 characters. */
function sanitize(p: Payload): { payload: Payload; dropped: string[] } {
  const out: Payload = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
    else dropped.push(k);
  }
  return { payload: out, dropped };
}

export function emit(event: CombEvent, raw: Payload): void {
  const { payload, dropped } = sanitize(raw);
  // Field names only: an object here could hold row values, which never leave as event data.
  if (dropped.length) console.warn(`event ${event}: dropped non-scalar payload fields ${dropped.join(', ')}`);
  for (const h of handlers) {
    Promise.resolve()
      .then(() => h(event, payload))
      .catch((e) => console.error('event handler failed', event, (e as Error).message));
  }
}

/** Adds an in-app notification for one user, or for everyone when userId is null. */
export async function notify(n: { userId?: string | null; kind: 'appr' | 'err' | 'job' | 'cat' | 'info'; title: string; body?: string; target?: string }): Promise<void> {
  await q('insert into notifications (user_id, kind, title, body, target) values ($1,$2,$3,$4,$5)', [
    n.userId ?? null, n.kind, n.title, n.body ?? '', n.target ?? null,
  ]);
}
