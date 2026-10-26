/*
 * Fetch wrapper for the Comb API. Cookies carry the session (httpOnly, SameSite=Strict);
 * every mutating request also sends the per-session CSRF token header.
 */

let csrfToken = '';
const listeners = new Set<(status: number, body: any) => void>();

export function setCsrf(token: string): void {
  csrfToken = token;
}

/** Called on 401/403-with-flags so the shell can bounce to login or MFA enrollment. */
export function onAuthProblem(fn: (status: number, body: any) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.error ?? `Request failed (${status})`);
  }
  /** Server asks for a typed confirmation before running something destructive. */
  get confirm(): { word: string; kind: string; target: string; sql?: string } | undefined {
    return this.status === 409 && this.body?.code === 'COMB_CONFIRM' ? this.body.confirm : undefined;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-comb-csrf'] = csrfToken;
  const res = await fetch('/api' + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    if (res.status === 401 || (res.status === 403 && data?.mfaEnroll)) listeners.forEach((l) => l(res.status, data));
    throw new ApiError(res.status, data);
  }
  return data as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T = any>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  patch: <T = any>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  del: <T = any>(path: string, body: unknown = {}) => request<T>('DELETE', path, body),
};

/** Triggers a browser download from data the client already holds (CSV exports). */
export function downloadText(filename: string, text: string, mime = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Downloads a server-generated file through fetch (keeps CSRF/cookies and handles errors). */
export async function downloadFrom(path: string, filename: string, body?: unknown): Promise<void> {
  const res = await fetch('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-comb-csrf': csrfToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
