import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReplicaInfo, TopologyResponse } from '@comb/shared/src/ops.ts';
import type { Tab } from '../lib/store.ts';
import { useApp, useConn, toastError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { withConfirm } from '../lib/confirm.ts';
import { ago, bytes, dateTime } from '../lib/format.ts';
import { Button, Callout, COND, ErrorBox, Label, Loading, Modal, MONO, TextInput } from '../ui/index.tsx';

/*
 * Cluster topology (mockup isTopologyTab): role, node cards, replication, slots, failover history.
 * Patroni is optional and per connection; without it, switchover is disabled and history is
 * derived from timeline switches, and the screen says so.
 */

const condLabel: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };

function lagFmt(s: number | null): string {
  if (s === null) return '—';
  if (s < 1) return Math.round(s * 1000) + ' ms';
  if (s < 90) return s.toFixed(1) + ' s';
  return Math.round(s / 60) + ' min';
}

function uptime(iso: string | null): string {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  return s < 86400 ? Math.round(s / 3600) + ' h' : Math.floor(s / 86400) + ' d';
}

interface NodeCard {
  key: string;
  role: string;
  host: string;
  sub: string;
  ok: boolean;
  primary: boolean;
  stats: Array<[string, string, boolean?]>;
  bars: number[];
}

function Card({ n }: { n: NodeCard }) {
  return (
    <div style={{ flex: '1 1 216px', minWidth: 200, maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 7, padding: '11px 12px', border: '1px solid var(--border-subtle)',
      borderTop: '3px solid ' + (n.primary ? 'var(--text-primary)' : n.ok ? 'var(--state-success)' : 'var(--state-running)'), borderRadius: 3, background: 'var(--bg-raised)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', padding: '1px 5px', whiteSpace: 'nowrap',
          background: n.primary ? 'var(--text-primary)' : 'transparent', color: n.primary ? 'var(--text-inverse)' : 'var(--text-secondary)', border: n.primary ? 'none' : '1px solid var(--border-strong)' }}>{n.role}</span>
        <span style={{ flex: 1 }} />
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: n.ok ? 'var(--state-success)' : 'var(--state-running)' }} />
      </div>
      <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.host}</div>
      <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>{n.sub}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px', alignItems: 'baseline' }}>
        {n.stats.map(([k, v, warn]) => (
          <React.Fragment key={k}>
            <span style={{ ...condLabel, whiteSpace: 'nowrap' }}>{k}</span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: warn ? 'var(--state-running)' : 'var(--text-primary)' }}>{v}</span>
          </React.Fragment>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 20 }} aria-hidden>
        {(n.bars.length ? n.bars : Array(12).fill(null)).map((v: number | null, i: number) => (
          <span key={i} style={{ flex: 1, height: v === null ? 1 : Math.max(2, Math.round(v * 20)),
            background: v === null ? 'var(--border-subtle)' : n.ok ? 'var(--border-strong)' : 'color-mix(in oklab, var(--state-running) 55%, transparent)' }} />
        ))}
      </div>
    </div>
  );
}

function normalise(v: number[]): number[] {
  const m = Math.max(0, ...v);
  return v.map((x) => (m > 0 ? Math.max(0.08, x / m) : 0.08));
}

function buildNodes(t: TopologyResponse): NodeCard[] {
  const nodes: NodeCard[] = [];
  const s = t.self;
  const region = t.region ? t.region + ' · ' : '';
  nodes.push({
    key: 'self', role: t.role === 'primary' ? 'PRIMARY' : 'REPLICA', host: `${t.host}:${t.port}`, sub: `${region}PostgreSQL ${t.version}${t.timeline ? ' · timeline ' + t.timeline : ''}`,
    ok: true, primary: t.role === 'primary',
    stats: [
      ['load', s.connTotal !== null ? `${s.connTotal} / ${s.maxConn} conn` : '—'],
      [t.role === 'primary' ? 'wal' : 'apply lag', t.role === 'primary' ? (s.walRate !== null ? bytes(s.walRate) + '/h' : '—') : lagFmt(t.upstream?.replayLag ?? null)],
      ['db size', bytes(s.dbSize)],
      ['uptime', uptime(t.startedAt)],
    ],
    bars: normalise(s.load),
  });
  for (const r of t.replicas) {
    const lagging = (r.replayLag ?? 0) > 1.5 || r.state !== 'streaming';
    nodes.push({
      key: 'r:' + r.name + r.addr, role: r.syncState === 'sync' ? 'SYNC REPLICA' : r.syncState === 'quorum' ? 'QUORUM REPLICA' : r.syncState === 'potential' ? 'POTENTIAL SYNC' : 'ASYNC REPLICA',
      host: r.name, sub: `${r.addr ?? 'local socket'} · ${r.state ?? 'unknown'}`, ok: !lagging, primary: false,
      stats: [
        ['write lag', lagFmt(r.writeLag)], ['apply lag', lagFmt(r.replayLag), (r.replayLag ?? 0) > 1.5],
        ['behind', bytes(r.replayBehind)], ['slot', r.slot ?? 'none'],
      ],
      bars: normalise(r.lagSeries),
    });
  }
  if (t.upstream) {
    nodes.push({
      key: 'upstream', role: 'UPSTREAM', host: t.upstream.host ? `${t.upstream.host}:${t.upstream.port ?? ''}` : 'unknown', sub: `wal receiver · ${t.upstream.status}`,
      ok: t.upstream.status === 'streaming', primary: false,
      stats: [['slot', t.upstream.slot ?? 'none'], ['last msg', t.upstream.lastMsgAt ? ago(t.upstream.lastMsgAt) : '—'], ['apply lag', lagFmt(t.upstream.replayLag), (t.upstream.replayLag ?? 0) > 1.5]],
      bars: [],
    });
  }
  if (t.archiver) {
    const failing = !!t.archiver.lastFailedAt && (!t.archiver.lastArchivedAt || t.archiver.lastFailedAt > t.archiver.lastArchivedAt);
    nodes.push({
      key: 'archive', role: 'WAL ARCHIVE', host: 'archive_command', sub: `archive_mode = ${t.archiver.mode}`, ok: !failing, primary: false,
      stats: [['last wal', t.archiver.lastArchivedAt ? ago(t.archiver.lastArchivedAt) : 'never'], ['archived', String(t.archiver.archived)], ['failed', String(t.archiver.failed), t.archiver.failed > 0]],
      bars: [],
    });
  }
  return nodes;
}

function ReplTable({ rows }: { rows: ReplicaInfo[] }) {
  const T = '170px 116px 96px 96px 140px minmax(150px,1fr)';
  const cell: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  const numCell: React.CSSProperties = { ...cell, justifyContent: 'flex-end', color: 'var(--text-secondary)' };
  const maxBehind = Math.max(1, ...rows.map((r) => r.replayBehind ?? 0));
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: T, minWidth: 760, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...condLabel }}>
        {['Replica', 'Mode', 'Write lag', 'Apply lag', 'Slot', 'Replay behind'].map((h, i) => (
          <div key={h} style={{ padding: '5px 10px', borderRight: i < 5 ? '1px solid var(--border-subtle)' : 'none', textAlign: i === 2 || i === 3 ? 'right' : 'left' }}>{h}</div>
        ))}
      </div>
      {rows.map((r, i) => (
        <div key={r.name + i} className="row-hover" style={{ display: 'grid', gridTemplateColumns: T, minWidth: 760, height: 32, borderBottom: i < rows.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
          <div style={cell} title={r.addr ?? ''}>{r.name}</div>
          <div style={{ ...cell }}>
            <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
              color: r.syncState === 'sync' || r.syncState === 'quorum' ? 'var(--state-success)' : 'var(--state-info)' }}>{r.syncState === 'async' ? 'asynchronous' : r.syncState === 'sync' ? 'synchronous' : r.syncState ?? '—'}</span>
          </div>
          <div style={numCell}>{lagFmt(r.writeLag)}</div>
          <div style={{ ...numCell, color: (r.replayLag ?? 0) > 1 ? 'var(--state-running)' : 'var(--text-secondary)' }}>{lagFmt(r.replayLag)}</div>
          <div style={cell}>{r.slot ?? '—'}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px' }}>
            <div style={{ flex: 1, minWidth: 50, height: 6, background: 'var(--bg-inset)', borderRadius: 3, overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: ((r.replayBehind ?? 0) / maxBehind) * 100 + '%', background: 'var(--state-info)' }} />
            </div>
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{bytes(r.replayBehind)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function PatroniModal({ t, connId, onClose }: { t: TopologyResponse; connId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(t.settings.patroniUrl ?? '');
  const [auth, setAuth] = useState('');
  const [hosts, setHosts] = useState(t.settings.allowHosts.join(', '));
  const [region, setRegion] = useState(t.settings.region ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (clearAuth = false) => {
    setBusy(true);
    setErr(null);
    try {
      await api.put(`/topology/${connId}/settings`, {
        patroniUrl: url.trim() || null, region: region.trim() || null,
        allowHosts: hosts.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean),
        ...(clearAuth ? { patroniAuth: null } : auth ? { patroniAuth: auth } : {}),
      });
      useApp.getState().toast('Topology settings saved', url ? 'Comb reads Patroni /cluster on the next refresh.' : 'Patroni integration is off.', 'success');
      qc.invalidateQueries({ queryKey: ['topology', connId] });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Patroni & cluster settings" onClose={onClose} width={560}
      footer={<><span className="spacer" />{t.settings.hasPatroniAuth ? <Button variant="ghost" onClick={() => save(true)} disabled={busy}>Clear credentials</Button> : null}
        <Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => save()} disabled={busy}>Save</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--text-secondary)' }}>
          With Patroni's REST API Comb shows cluster members and failover history, and can run a planned switchover. Requests go through the outbound guard:
          private, loopback and link-local addresses are refused unless the host is allowlisted below; cloud metadata addresses never.
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><Label>Patroni REST URL</Label>
          <TextInput mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://patroni.internal:8008" /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><Label>Credentials (user:password, optional)</Label>
          <TextInput mono type="password" value={auth} onChange={(e) => setAuth(e.target.value)} placeholder={t.settings.hasPatroniAuth ? 'stored · leave empty to keep' : 'restapi.authentication'} autoComplete="off" /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><Label>Allowlisted hosts (private addresses)</Label>
          <TextInput mono value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="patroni.internal, 10.0.4.12" /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><Label>Region label</Label>
          <TextInput value={region} onChange={(e) => setRegion(e.target.value)} placeholder="eu-central-1" /></label>
        {err ? <Callout kind="error" title="Not saved">{err}</Callout> : null}
      </div>
    </Modal>
  );
}

/** Cluster topology. */
export default function TopologyScreen({ tab }: { tab: Tab }) {
  void tab;
  const conn = useConn();
  const me = useApp((s) => s.me);
  const qc = useQueryClient();
  const [settings, setSettings] = useState(false);
  const [candidate, setCandidate] = useState('');
  const topo = useQuery({ queryKey: ['topology', conn.id], queryFn: () => api.get<TopologyResponse>(`/topology/${conn.id}`), refetchInterval: 15_000 });
  const t = topo.data;
  const isAdmin = me?.role === 'Owner' || me?.role === 'Admin';
  const canSwitch = !!t?.patroni.configured && !t.patroni.error && conn.level === 'admin' && isAdmin;

  const switchover = async () => {
    try {
      const r = await withConfirm((confirm) => api.post(`/topology/${conn.id}/switchover`, { candidate: candidate || undefined, confirm }), {
        title: `Planned switchover on ${conn.name}`,
        body: 'Patroni demotes the current leader and promotes a replica. Writes pause for the length of the switchover and every session on the old leader is disconnected.',
      });
      if (r) {
        useApp.getState().toast('Switchover requested', 'Patroni is switching the leader. Watch the node cards.', 'info');
        qc.invalidateQueries({ queryKey: ['topology', conn.id] });
      }
    } catch (e) {
      toastError(e, 'Switchover not started');
    }
  };

  const summary = t
    ? [
        t.role === 'primary' ? '1 primary' : 'replica',
        t.role === 'primary' ? `${t.replicas.length} replica${t.replicas.length === 1 ? '' : 's'}` : `upstream ${t.upstream?.host ?? 'unknown'}`,
        t.replicas.some((r) => r.syncState === 'sync' || r.syncState === 'quorum') ? 'synchronous' : t.replicas.length ? 'asynchronous' : null,
        t.timeline ? 'timeline ' + t.timeline : null,
        t.region,
        t.patroni.scope ? 'patroni · ' + t.patroni.scope : null,
      ].filter(Boolean).join(' · ')
    : '';
  const replicaMembers = t?.patroni.members.filter((m) => m.role !== 'leader' && m.role !== 'standby_leader') ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflowX: 'auto' }}>
        <span style={{ ...condLabel, whiteSpace: 'nowrap', flex: 'none' }}>Cluster</span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none' }}>{summary}</span>
        <span style={{ flex: 1, minWidth: 8 }} />
        {isAdmin ? <Button size="sm" onClick={() => setSettings(true)}>Patroni…</Button> : null}
        {canSwitch && replicaMembers.length ? (
          <select value={candidate} onChange={(e) => setCandidate(e.target.value)} style={{ height: 22, fontSize: 12, fontFamily: MONO, background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 3 }}>
            <option value="">any healthy replica</option>
            {replicaMembers.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
          </select>
        ) : null}
        <Button size="sm" disabled={!canSwitch} onClick={switchover} style={{ color: canSwitch ? 'var(--state-running)' : 'var(--text-muted)' }}
          title={!t?.patroni.configured ? 'Planned switchover needs Patroni. Set its REST URL with Patroni….' : conn.level !== 'admin' ? `Needs admin access on ${conn.name}` : t?.patroni.error ?? ''}>
          Planned switchover…
        </Button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {topo.isLoading ? <Loading /> : topo.error ? <ErrorBox error={topo.error} onRetry={() => topo.refetch()} /> : null}
          {t ? (
            <>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
                {buildNodes(t).map((n) => <Card key={n.key} n={n} />)}
              </div>

              {t.patroni.error ? <Callout kind="error" title="Patroni unreachable">{t.patroni.error}</Callout> : null}
              {!t.patroni.configured ? (
                <Callout kind="info" title="No Patroni configured for this connection">
                  Comb reads roles and replication from Postgres itself. Planned switchover and a full failover history need Patroni's REST API{isAdmin ? ' (Patroni… above)' : ''}.
                </Callout>
              ) : null}

              {t.patroni.members.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={condLabel}>Patroni members · {t.patroni.scope ?? 'cluster'}</div>
                  <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
                    {t.patroni.members.map((m, i) => (
                      <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 30, borderTop: i ? '1px solid var(--border-subtle)' : 'none', fontFamily: MONO, fontSize: 12 }}>
                        <span style={{ width: 160 }}>{m.name}</span>
                        <span style={{ ...condLabel, width: 110, color: m.role === 'leader' ? 'var(--text-primary)' : 'var(--state-info)' }}>{m.role}</span>
                        <span style={{ width: 100, color: m.state === 'running' || m.state === 'streaming' ? 'var(--state-success)' : 'var(--state-running)' }}>{m.state}</span>
                        <span style={{ flex: 1, color: 'var(--text-muted)' }}>{m.host}:{m.port} · tl {m.timeline ?? '—'}</span>
                        <span style={{ color: 'var(--text-muted)' }}>lag {m.lag ?? 0}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={condLabel}>Replication</div>
                {t.role === 'primary' && t.replicas.length === 0 ? (
                  <div style={{ padding: '18px 14px', border: '1px dashed var(--border-strong)', borderRadius: 3, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 500 }}>Single node. No replicas are streaming from this primary.</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Replicas appear here as soon as they connect (pg_stat_replication), with their lag and slot.</span>
                  </div>
                ) : t.role === 'replica' ? (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>This connection is a replica: it streams from {t.upstream?.host ?? 'an unknown upstream'} ({t.upstream?.status ?? 'unknown'}). Open the primary's connection to see every replica.</div>
                ) : <ReplTable rows={t.replicas} />}
              </div>

              {t.slots.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={condLabel}>Replication slots</div>
                  <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
                    {t.slots.map((s, i) => (
                      <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 30, borderTop: i ? '1px solid var(--border-subtle)' : 'none',
                        background: s.warn ? 'color-mix(in oklab, var(--state-running) 8%, transparent)' : 'transparent' }}>
                        <span style={{ fontFamily: MONO, fontSize: 12, width: 180, flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                        <span style={{ ...condLabel, width: 70 }}>{s.type}</span>
                        <span style={{ ...condLabel, width: 70, color: s.active ? 'var(--state-success)' : 'var(--state-running)' }}>{s.active ? 'active' : 'inactive'}</span>
                        <span style={{ fontFamily: MONO, fontSize: 12, flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: s.warn ? 'var(--state-running)' : 'var(--text-secondary)' }}
                          title={`retains ${bytes(s.retainedBytes)} of WAL${s.walStatus ? ` · ${s.walStatus}` : ''}`}>
                          retains {bytes(s.retainedBytes)} of WAL{s.walStatus ? ` · ${s.walStatus}` : ''}
                        </span>
                        {s.warn ? <span style={{ fontSize: 12, color: 'var(--state-running)', flex: 'none', maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.active ? 'large WAL retention' : 'inactive slot holding WAL — drop it if the consumer is gone'}</span> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={condLabel}>Failover history</div>
                <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
                  {t.history.events.length === 0 ? <div style={{ padding: '12px', fontSize: 12, color: 'var(--text-muted)' }}>No failovers recorded.</div> : null}
                  {t.history.events.map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 30, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
                      <span style={{ fontFamily: MONO, fontSize: 12, width: 124, flex: 'none', color: 'var(--text-muted)' }}>{f.at ? dateTime(f.at) : 'time unknown'}</span>
                      <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', width: 82, flex: 'none', color: f.kind === 'PLANNED' ? 'var(--state-info)' : 'var(--state-running)' }}>{f.kind}</span>
                      <span style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.text}</span>
                      <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>{f.timeline ? 'tl ' + f.timeline : ''}</span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>{t.history.note}</div>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {settings && t ? <PatroniModal t={t} connId={conn.id} onClose={() => setSettings(false)} /> : null}
    </div>
  );
}
