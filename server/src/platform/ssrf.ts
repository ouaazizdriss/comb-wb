import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/*
 * SSRF guard for every outbound HTTP call Comb makes (webhooks, Slack, IdP metadata, Patroni...).
 *
 *  - http(s) only, no credentials in the URL.
 *  - The host is resolved here, every resolved address is vetted (loopback, RFC1918, CGNAT,
 *    link-local / cloud metadata, ULA, multicast, reserved, IPv4-mapped/compatible/NAT64/6to4
 *    forms of all of those are refused), and the socket connects to the vetted address through a
 *    pinned `lookup`, so a second DNS answer (rebinding) can never change where we connect.
 *    Host header and TLS SNI still carry the original host name, so certificates verify normally.
 *  - Redirects are never followed blindly: each Location is re-vetted, at most 3 hops.
 *  - Timeout (default 8 s), 1 MB response cap, no cookies sent or kept.
 *
 * Private hosts can be reached only if an Admin put the host name (or literal IP) on the
 * workspace allowlist `integrations.allow_private_hosts`, or the caller passes `allowHosts`.
 */

export class SsrfError extends Error {
  code = 'COMB_SSRF';
}

export interface SafeFetchInit extends RequestInit {
  timeoutMs?: number;
  allowHosts?: string[];
  /** Response size cap in bytes (default 1 MB). */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT = 8_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

type AllowlistProvider = () => Promise<string[]>;
let allowlistProvider: AllowlistProvider = async () => [];

/** The integrations module plugs the workspace allowlist setting in here. */
export function setAllowlistProvider(fn: AllowlistProvider): void {
  allowlistProvider = fn;
}

// ── Address classification ───────────────────────────────────────

function v4Bytes(ip: string): number[] | null {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').map(Number);
}

/** Parses an IPv6 literal (zone ids stripped, embedded IPv4 tail allowed) into 16 bytes. */
function v6Bytes(ip: string): number[] | null {
  let addr = ip.replace(/%.*$/, '');
  if (!net.isIPv6(addr)) return null;
  const tail = addr.slice(addr.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const b = v4Bytes(tail);
    if (!b) return null;
    addr = addr.slice(0, addr.length - tail.length) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16);
  }
  const parts = addr.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const groups = [...left, ...Array(fill).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(g) || n > 0xffff) return null;
    out.push(n >> 8, n & 0xff);
  }
  return out;
}

function inV4(b: number[], base: number[], bits: number): boolean {
  const ip = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  const net = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (net & mask);
}

const V4_BLOCKED: Array<[number[], number, string]> = [
  [[0, 0, 0, 0], 8, 'this network'],
  [[10, 0, 0, 0], 8, 'private (RFC 1918)'],
  [[100, 64, 0, 0], 10, 'carrier-grade NAT'],
  [[127, 0, 0, 0], 8, 'loopback'],
  [[169, 254, 0, 0], 16, 'link-local / cloud metadata'],
  [[172, 16, 0, 0], 12, 'private (RFC 1918)'],
  [[192, 0, 0, 0], 24, 'IETF protocol assignments'],
  [[192, 0, 2, 0], 24, 'documentation'],
  [[192, 88, 99, 0], 24, '6to4 relay'],
  [[192, 168, 0, 0], 16, 'private (RFC 1918)'],
  [[198, 18, 0, 0], 15, 'benchmarking'],
  [[198, 51, 100, 0], 24, 'documentation'],
  [[203, 0, 113, 0], 24, 'documentation'],
  [[224, 0, 0, 0], 4, 'multicast'],
  [[240, 0, 0, 0], 4, 'reserved / broadcast'],
];

function classifyV4(b: number[]): string | null {
  for (const [base, bits, why] of V4_BLOCKED) if (inV4(b, base, bits)) return why;
  return null;
}

function classifyV6(b: number[]): string | null {
  const allZeroUpTo = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (b.every((x) => x === 0)) return 'unspecified (::)';
  if (allZeroUpTo(15) && b[15] === 1) return 'loopback';
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (allZeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12)) ?? null;
  if (allZeroUpTo(12)) return classifyV4(b.slice(12)) ?? 'IPv4-compatible address';
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return classifyV4(b.slice(12)) ?? null;
  // 6to4 2002::/16 embeds an IPv4 address in bits 16..48
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6)) ? '6to4 of a blocked IPv4 address' : null;
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local (fe80::/10)';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return 'site-local (fec0::/10)';
  if ((b[0] & 0xfe) === 0xfc) return 'unique-local (fc00::/7)';
  if (b[0] === 0xff) return 'multicast';
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'documentation';
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) return 'discard prefix (100::/64)';
  return null;
}

/** Returns why an IP literal is not publicly routable, or null when it is fine. */
export function blockedReason(ip: string): string | null {
  const v4 = v4Bytes(ip);
  if (v4) return classifyV4(v4);
  const v6 = v6Bytes(ip);
  if (v6) return classifyV6(v6);
  return 'not an IP address';
}

// Carrier-grade NAT is included because overlay networks (Tailscale) use it; its metadata address is excluded below.
const PRIVATE_REASONS = new Set(['private (RFC 1918)', 'loopback', 'unique-local (fc00::/7)', 'carrier-grade NAT']);
/**
 * Byte key of an address. IPv6 forms that classifyV6 judges by an embedded IPv4 address (mapped, compatible,
 * NAT64) reduce to that IPv4, so the metadata check below sees the same address the classifier did.
 */
function addrKey(ip: string): string | null {
  const v4 = v4Bytes(ip);
  if (v4) return v4.join('.');
  const b = v6Bytes(ip);
  if (!b) return null;
  const zeroTo10 = b.slice(0, 10).every((x) => x === 0);
  const mapped = zeroTo10 && b[10] === 0xff && b[11] === 0xff;
  const compatible = zeroTo10 && b[10] === 0 && b[11] === 0;
  const nat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b;
  return mapped || compatible || nat64 ? b.slice(12).join('.') : b.join(',');
}
const CLOUD_METADATA = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254', '192.0.0.192'].map((a) => addrKey(a)!));

/**
 * True when an address is blocked only because it is on a private network (RFC 1918, loopback, unique-local, CGNAT),
 * the one case a per-feature allowlist may lift. Cloud metadata, link-local and every other reserved range
 * stay blocked, however the address is written (IPv4-mapped/compatible, 6to4, NAT64).
 */
export function isPrivateOnly(ip: string): boolean {
  const why = blockedReason(ip);
  if (!why || !PRIVATE_REASONS.has(why)) return false;
  const key = addrKey(ip);
  return !!key && !CLOUD_METADATA.has(key);
}

// ── Host vetting ─────────────────────────────────────────────────

export interface VettedHost {
  /** Host name as written in the URL (brackets stripped for IPv6). */
  host: string;
  /** The address the socket will connect to. */
  address: string;
  family: 4 | 6;
  allowlisted: boolean;
}

function normHost(h: string): string {
  return h.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

async function allowed(host: string, extra: string[] | undefined): Promise<boolean> {
  let list: string[] = [];
  try {
    list = await allowlistProvider();
  } catch {
    list = [];
  }
  const h = normHost(host);
  return [...list, ...(extra ?? [])].some((a) => normHost(String(a)) === h);
}

/**
 * Resolves a host name and vets every address. Throws SsrfError when the host resolves to
 * anything non-public and is not allowlisted. Used by safeFetch and the SMTP client.
 */
export async function vetHost(rawHost: string, allowHosts?: string[]): Promise<VettedHost> {
  const host = normHost(rawHost);
  if (!host) throw new SsrfError('Missing host');
  const isAllowed = await allowed(host, allowHosts);
  let addrs: Array<{ address: string; family: number }>;
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIP(host) }];
  } else {
    if (host === 'localhost' || host.endsWith('.localhost')) {
      if (!isAllowed) throw new SsrfError(`Refused ${host}: loopback`);
    }
    try {
      addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
    } catch (e) {
      throw new SsrfError(`Could not resolve ${host}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    if (!addrs.length) throw new SsrfError(`Could not resolve ${host}`);
  }
  // Checked on every resolution, so an allowlisted name that rebinds to metadata or a reserved range is still refused:
  // an allowlist only ever lifts private-network addresses.
  for (const a of addrs) {
    const why = blockedReason(a.address);
    if (!why) continue;
    if (isAllowed && isPrivateOnly(a.address)) continue;
    throw new SsrfError(isAllowed
      ? `Refused ${host}: it resolves to a ${why} address, which an allowlist cannot open.`
      : `Refused ${host}: it resolves to a ${why} address. An Admin can allowlist this host under Integrations if it is meant to be reachable.`);
  }
  const pick = addrs[0];
  return { host, address: pick.address, family: pick.family === 6 ? 6 : 4, allowlisted: isAllowed };
}

// ── Fetch ────────────────────────────────────────────────────────

function headersToObject(h: RequestInit["headers"] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function bodyToBuffer(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('safeFetch supports string, URLSearchParams and binary bodies only');
}

interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
}

function requestOnce(url: URL, vetted: VettedHost, method: string, headers: Record<string, string>, body: Buffer | undefined, deadline: number, maxBytes: number, signal?: AbortSignal | null): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new SsrfError('Request timed out'));
    const pinned = (_h: string, opts: any, cb: (...a: any[]) => void) => {
      if (opts && opts.all) cb(null, [{ address: vetted.address, family: vetted.family }]);
      else cb(null, vetted.address, vetted.family);
    };
    const hostIsIp = net.isIP(vetted.host) !== 0;
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
    const hdrs = { ...headers };
    // No cookies, ever: neither the caller's nor anything a server sets.
    delete hdrs.cookie;
    hdrs.host = url.host;
    if (body) hdrs['content-length'] = String(body.length);
    const req = mod.request({
      method,
      host: vetted.host,
      port,
      path: url.pathname + url.search,
      headers: hdrs,
      lookup: pinned as any,
      // When the host is a literal IP, net.connect never calls lookup; it is already vetted.
      ...(isHttps && !hostIsIp ? { servername: vetted.host } : {}),
      agent: false,
      timeout: remaining,
    });
    let done = false;
    const fail = (e: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new SsrfError('Request timed out')), remaining);
    const onAbort = () => fail(new SsrfError('Request aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => fail(new SsrfError('Request timed out')));
    req.on('error', (e) => fail(e));
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          fail(new SsrfError(`Response larger than ${Math.round(maxBytes / 1024)} kB`));
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('error', (e) => fail(e));
      res.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (k === 'set-cookie' || v === undefined) continue;
          if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
          else h.set(k, String(v));
        }
        resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers: h, body: Buffer.concat(chunks) });
      });
    });
    if (body) req.write(body);
    req.end();
  });
}

function checkUrl(u: URL): void {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError(`Only http and https URLs are allowed (got ${u.protocol})`);
  if (u.username || u.password) throw new SsrfError('Credentials in the URL are not allowed');
}

/**
 * fetch() replacement for outbound calls. See the header comment for the guarantees.
 * Returns a standard Response whose body is already buffered (≤ maxBytes).
 */
export async function safeFetch(url: string, init: SafeFetchInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT, allowHosts, maxBytes = DEFAULT_MAX_BYTES, redirect = 'follow' } = init;
  const deadline = Date.now() + timeoutMs;
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new SsrfError('Invalid URL');
  }
  let method = (init.method ?? 'GET').toUpperCase();
  let headers = headersToObject(init.headers);
  let body = bodyToBuffer(init.body);
  for (let hop = 0; ; hop++) {
    checkUrl(current);
    const vetted = await vetHost(current.hostname, allowHosts);
    const raw = await requestOnce(current, vetted, method, headers, body, deadline, maxBytes, init.signal);
    const loc = raw.headers.get('location');
    if (raw.status >= 300 && raw.status < 400 && loc && redirect !== 'manual') {
      if (redirect === 'error') throw new SsrfError('Redirect refused');
      if (hop >= MAX_REDIRECTS) throw new SsrfError(`Too many redirects (max ${MAX_REDIRECTS})`);
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        throw new SsrfError('Invalid redirect location');
      }
      if (next.origin !== current.origin) {
        // Never forward credentials or signatures to another origin.
        for (const k of Object.keys(headers)) if (/^(authorization|proxy-authorization|x-comb-signature|dd-api-key)$/i.test(k)) delete headers[k];
      }
      if (raw.status === 303 || ((raw.status === 301 || raw.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(type|length)$/i.test(k)));
      }
      current = next;
      continue;
    }
    const nullBody = raw.status === 204 || raw.status === 205 || raw.status === 304 || method === 'HEAD';
    const status = raw.status < 200 || raw.status > 599 ? 502 : raw.status;
    const res = new Response(nullBody ? null : new Uint8Array(raw.body), { status, statusText: raw.statusText, headers: raw.headers });
    Object.defineProperty(res, 'url', { value: current.toString() });
    return res;
  }
}
