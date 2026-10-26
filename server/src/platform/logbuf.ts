import util from 'node:util';

/*
 * In-memory ring buffer of this process's console.warn / console.error lines, for the
 * Deployment → Services → logs panel. Lines are redacted (connection strings, bearer tokens,
 * key=value secrets, long opaque tokens) and truncated; nothing persists to disk.
 * Comb never console-logs request bodies; the Fastify logger (pino) writes to stdout separately
 * and is not captured here.
 */

export interface LogLine {
  at: string;
  level: 'warn' | 'error';
  text: string;
}

const MAX = 200;
const MAX_LEN = 500;
const ring: LogLine[] = [];
let installed = false;

export function redact(s: string): string {
  return s
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]*)@/gi, '$1$2:•••@')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 •••')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|routing[_-]?key|signature|cookie)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1$2•••')
    .replace(/https:\/\/hooks\.slack\.com\/[^\s"']+/gi, 'https://hooks.slack.com/•••')
    .replace(/\bcomb_[A-Za-z0-9_-]{16,}/g, 'comb_•••')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (m) => m.slice(0, 4) + '•••');
}

function push(level: LogLine['level'], args: unknown[]): void {
  try {
    const raw = util.format(...args.map((a) => (a instanceof Error ? a.message : a)));
    let text = redact(raw.replace(/\s+/g, ' ').trim());
    if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN) + '…';
    ring.push({ at: new Date().toISOString(), level, text });
    if (ring.length > MAX) ring.splice(0, ring.length - MAX);
  } catch {
    /* never let logging break the caller */
  }
}

/** Wraps console.warn / console.error once per process. */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  const warn = console.warn.bind(console);
  const error = console.error.bind(console);
  console.warn = (...a: unknown[]) => {
    push('warn', a);
    warn(...a);
  };
  console.error = (...a: unknown[]) => {
    push('error', a);
    error(...a);
  };
}

export function recentLogs(): LogLine[] {
  return ring.slice();
}
