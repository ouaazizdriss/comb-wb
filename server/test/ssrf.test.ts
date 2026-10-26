import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { blockedReason, safeFetch, setAllowlistProvider, SsrfError } from '../src/platform/ssrf.ts';

/*
 * The SSRF guard is tested without touching the network: DNS is mocked, and the one "public" host
 * is routed to a local server by wrapping the pinned lookup safeFetch hands to http.request.
 */

type Lookup = typeof dns.promises.lookup;
let port = 0;
let server: http.Server;
const seen: Array<{ url: string; host: string | undefined; cookie: string | undefined }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', host: req.headers.host, cookie: req.headers.cookie });
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/ok') { res.setHeader('set-cookie', 'a=b'); res.end('hello'); return; }
    if (u.pathname === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    if (u.pathname === '/to-loopback-ip') { res.writeHead(302, { location: `http://127.0.0.1:${port}/ok` }); res.end(); return; }
    if (u.pathname === '/to-ok') { res.writeHead(301, { location: '/ok' }); res.end(); return; }
    if (u.pathname === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
    if (u.pathname === '/slow') { setTimeout(() => res.end('late'), 1500); return; }
    if (u.pathname === '/big') { res.end(Buffer.alloc(2 * 1024 * 1024, 97)); return; }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

afterEach(() => {
  vi.restoreAllMocks();
  setAllowlistProvider(async () => []);
  seen.length = 0;
});

function mockDns(map: Record<string, string[]>) {
  return vi.spyOn(dns.promises, 'lookup').mockImplementation((async (host: string) => {
    const a = map[host];
    if (!a) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }) as unknown as Lookup);
}

/** Lets a vetted public address actually connect to the local test server (and records what was vetted). */
function routePublicToLocal(publicIp: string) {
  const vettedAddrs: string[] = [];
  const real = http.request;
  vi.spyOn(http, 'request').mockImplementation(((opts: any, cb?: any) => {
    const pinned = opts.lookup;
    const lookup = (h: string, o: any, done: (...a: any[]) => void) => {
      pinned(h, o, (err: Error | null, addr: any, fam?: number) => {
        const a = Array.isArray(addr) ? addr[0].address : addr;
        vettedAddrs.push(a);
        expect(a).toBe(publicIp);
        if (Array.isArray(addr)) done(err, [{ address: '127.0.0.1', family: 4 }]);
        else done(err, '127.0.0.1', 4);
      });
    };
    return real({ ...opts, lookup }, cb);
  }) as any);
  return vettedAddrs;
}

const refused = async (url: string, init?: Parameters<typeof safeFetch>[1]) => {
  await expect(safeFetch(url, init)).rejects.toBeInstanceOf(SsrfError);
};

describe('blockedReason', () => {
  it.each([
    ['127.0.0.1', true], ['127.255.0.9', true], ['10.0.0.1', true], ['172.16.5.4', true], ['172.31.255.255', true], ['192.168.1.1', true],
    ['100.64.0.1', true], ['169.254.169.254', true], ['0.0.0.0', true], ['0.1.2.3', true], ['224.0.0.1', true], ['255.255.255.255', true],
    ['::', true], ['::1', true], ['fe80::1', true], ['fd00::1', true], ['fc12::9', true], ['ff02::1', true],
    ['::ffff:127.0.0.1', true], ['::ffff:7f00:1', true], ['::ffff:10.0.0.1', true], ['::ffff:a9fe:a9fe', true], ['::127.0.0.1', true],
    ['64:ff9b::a9fe:a9fe', true], ['2002:7f00:1::', true],
    ['8.8.8.8', false], ['93.184.216.34', false], ['172.32.0.1', false], ['100.128.0.1', false], ['2606:4700:4700::1111', false], ['::ffff:8.8.8.8', false],
  ])('%s blocked=%s', (ip, blocked) => {
    expect(blockedReason(ip) !== null).toBe(blocked);
  });
});

describe('safeFetch refuses internal targets', () => {
  it('127.0.0.1', () => refused(`http://127.0.0.1:${port}/ok`));
  it('localhost (without even asking DNS)', async () => {
    const spy = mockDns({ localhost: ['127.0.0.1'] });
    await refused(`http://localhost:${port}/ok`);
    expect(spy).not.toHaveBeenCalled();
  });
  it('10.x', () => refused('http://10.1.2.3/'));
  it('cloud metadata 169.254.169.254', () => refused('http://169.254.169.254/latest/meta-data/'));
  it('[::1]', () => refused(`http://[::1]:${port}/ok`));
  it('::ffff:127.0.0.1 (IPv4-mapped)', () => refused(`http://[::ffff:127.0.0.1]:${port}/ok`));
  it('decimal IP 2130706433', () => refused(`http://2130706433:${port}/ok`));
  it('hex IP 0x7f000001', () => refused(`http://0x7f000001:${port}/ok`));
  it('dotted hex/octal 0x7f.0.0.01', () => refused(`http://0x7f.0.0.01:${port}/ok`));
  it('a name resolving to a private address', async () => {
    mockDns({ 'intranet.example': ['10.9.8.7'] });
    await refused('http://intranet.example/');
  });
  it('a name where any answer is private', async () => {
    mockDns({ 'mixed.example': ['93.184.216.34', '192.168.0.10'] });
    await refused('http://mixed.example/');
  });
  it('non-http schemes and credentials in the URL', async () => {
    await refused('file:///etc/passwd');
    await refused('ftp://example.com/');
    await refused('gopher://example.com/');
    mockDns({ 'example.com': ['93.184.216.34'] });
    await refused('http://user:pw@example.com/');
  });
  it('unresolvable hosts', async () => {
    mockDns({});
    await refused('http://nowhere.invalid/');
  });
});

describe('safeFetch to allowed hosts', () => {
  it('connects a public host to the vetted address, with the original Host header', async () => {
    mockDns({ 'public.example': ['93.184.216.34'] });
    const vetted = routePublicToLocal('93.184.216.34');
    const r = await safeFetch(`http://public.example:${port}/ok`, { headers: { cookie: 'session=secret' } });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('hello');
    expect(vetted).toEqual(['93.184.216.34']);
    expect(seen[0].host).toBe(`public.example:${port}`);
    expect(seen[0].cookie).toBeUndefined();
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('resolves DNS once per hop, so a rebinding second answer is never used', async () => {
    let calls = 0;
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => {
      calls++;
      return [{ address: calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    }) as unknown as Lookup);
    const vetted = routePublicToLocal('93.184.216.34');
    const r = await safeFetch(`http://rebind.example:${port}/ok`);
    expect(r.status).toBe(200);
    expect(calls).toBe(1);
    expect(vetted).toEqual(['93.184.216.34']);
  });

  it('allowHosts lets a private host through', async () => {
    mockDns({ 'hooks.internal': ['127.0.0.1'] });
    const r = await safeFetch(`http://hooks.internal:${port}/ok`, { allowHosts: ['hooks.internal'] });
    expect(r.status).toBe(200);
  });

  it('the workspace allowlist setting lets a private host through', async () => {
    await refused(`http://127.0.0.1:${port}/ok`);
    setAllowlistProvider(async () => ['127.0.0.1']);
    const r = await safeFetch(`http://127.0.0.1:${port}/ok`);
    expect(await r.text()).toBe('hello');
  });
});

describe('safeFetch redirects, timeouts, size', () => {
  it('re-vets a redirect to the metadata address and refuses it', async () => {
    mockDns({ 'hooks.internal': ['127.0.0.1'] });
    await refused(`http://hooks.internal:${port}/to-metadata`, { allowHosts: ['hooks.internal'] });
    expect(seen.map((s) => s.url)).toEqual(['/to-metadata']);
  });
  it('refuses a redirect to an internal IP that is not itself allowlisted', async () => {
    mockDns({ 'hooks.internal': ['127.0.0.1'] });
    await refused(`http://hooks.internal:${port}/to-loopback-ip`, { allowHosts: ['hooks.internal'] });
  });
  it('follows a same-host redirect after re-vetting', async () => {
    mockDns({ 'hooks.internal': ['127.0.0.1'] });
    const r = await safeFetch(`http://hooks.internal:${port}/to-ok`, { allowHosts: ['hooks.internal'] });
    expect(await r.text()).toBe('hello');
  });
  it('stops after 3 redirects', async () => {
    mockDns({ 'hooks.internal': ['127.0.0.1'] });
    await expect(safeFetch(`http://hooks.internal:${port}/loop`, { allowHosts: ['hooks.internal'] })).rejects.toThrow(/Too many redirects/);
    expect(seen.length).toBe(4);
  });
  it('redirect: manual returns the 3xx without following', async () => {
    mockDns({ 'hooks.internal': ['127.0.0.1'] });
    const r = await safeFetch(`http://hooks.internal:${port}/to-metadata`, { allowHosts: ['hooks.internal'], redirect: 'manual' });
    expect(r.status).toBe(302);
  });
  it('times out', async () => {
    mockDns({ 'hooks.internal': ['127.0.0.1'] });
    await expect(safeFetch(`http://hooks.internal:${port}/slow`, { allowHosts: ['hooks.internal'], timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });
  it('caps the response size at 1 MB', async () => {
    mockDns({ 'hooks.internal': ['127.0.0.1'] });
    await expect(safeFetch(`http://hooks.internal:${port}/big`, { allowHosts: ['hooks.internal'] })).rejects.toThrow(/larger than/);
  });

  it('an allowlist never opens metadata or reserved addresses, even after a DNS change', async () => {
    mockDns({ 'patroni.internal': ['169.254.169.254'] });
    await expect(safeFetch('http://patroni.internal/', { allowHosts: ['patroni.internal'] })).rejects.toThrow(/allowlist cannot open/);
    mockDns({ 'patroni.internal': ['::ffff:169.254.169.254'] });
    await expect(safeFetch('http://patroni.internal/', { allowHosts: ['patroni.internal'] })).rejects.toThrow(/allowlist cannot open/);
    mockDns({ 'patroni.internal': ['100.100.100.200'] });
    await expect(safeFetch('http://patroni.internal/', { allowHosts: ['patroni.internal'] })).rejects.toThrow(/allowlist cannot open/);
    // NAT64 spellings of a metadata address inside the CGNAT range (100.100.100.200).
    for (const a of ['64:ff9b::6464:64c8', '64:ff9b:1::6464:64c8', '::6464:64c8']) {
      mockDns({ 'patroni.internal': [a] });
      await expect(safeFetch('http://patroni.internal/', { allowHosts: ['patroni.internal'] })).rejects.toThrow(/allowlist cannot open/);
    }
  });
});
