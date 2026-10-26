import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FlagKey, MemberCounts, ReleaseRow, ServiceRow } from '@comb/shared/src/platform.ts';
import type { Tab } from '../lib/store.ts';
import { useApp, toastError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { bytes, dateTime } from '../lib/format.ts';
import { Button, Callout, CodeLines, COND, Empty, ErrorBox, Loading, MONO, Modal, Seg, Toggle } from '../ui/index.tsx';

const SECTION: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };
const SVC_T = 'minmax(180px,1fr) 100px 80px 170px 130px';

interface Overview { version: string; startedAt: string; uptimeS: number; metaDb: { sizeBytes: number; auditBytes: number }; pendingMigrations: string[]; latest: string | null }
interface Releases { current: string; releases: ReleaseRow[]; latest: string | null; feed: { configured: boolean; error: string | null }; upgrade: { version: string; docker: string; helm: string } | null }
interface Flags { flags: Record<FlagKey, boolean>; defs: Array<{ key: FlagKey; hint: string; default: boolean }> }

function uptime(s: number): string {
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min';
  if (s < 86400 * 2) return (s / 3600).toFixed(1) + ' h';
  return Math.round(s / 86400) + ' d';
}

function Kpi({ value, label, note, tone = 'var(--state-success)' }: { value: React.ReactNode; label: string; note: React.ReactNode; tone?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 11px', border: '1px solid var(--border-subtle)', borderLeft: `3px solid ${tone}`, borderRadius: 3, background: 'var(--bg-raised)', minWidth: 0 }}>
      <span style={{ fontFamily: MONO, fontSize: 20, lineHeight: '26px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      <span style={SECTION}>{label}</span>
      <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{note}</span>
    </div>
  );
}

const stateColor = (s: ServiceRow['state']) => (s === 'healthy' ? 'var(--state-success)' : s === 'degraded' ? 'var(--state-running)' : s === 'down' ? 'var(--state-error)' : 'var(--text-muted)');

/** Deployment: KPIs, services, feature flags, release history. */
export default function DeployScreen({ tab }: { tab: Tab }) {
  void tab;
  const me = useApp((s) => s.me);
  const isAdmin = me?.role === 'Admin' || me?.role === 'Owner';
  const ov = useQuery({ queryKey: ['deploy-overview'], queryFn: () => api.get<Overview>('/deploy/overview'), enabled: isAdmin, refetchInterval: 30_000, retry: false });
  const svc = useQuery({ queryKey: ['deploy-services'], queryFn: () => api.get<ServiceRow[]>('/deploy/services'), enabled: isAdmin, refetchInterval: 10_000, retry: false });
  const members = useQuery({ queryKey: ['deploy-members'], queryFn: () => api.get<MemberCounts>('/deploy/members'), enabled: isAdmin, retry: false });
  const rel = useQuery({ queryKey: ['deploy-releases'], queryFn: () => api.get<Releases>('/deploy/releases'), enabled: isAdmin, retry: false });
  const flags = useQuery({ queryKey: ['deploy-flags'], queryFn: () => api.get<Flags>('/deploy/flags'), retry: false });
  const [logsFor, setLogsFor] = useState<ServiceRow | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const header = (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 280 }}>
        <div style={{ fontSize: 20, lineHeight: '26px', fontWeight: 600 }}>Deployment</div>
        <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--text-secondary)' }}>This Comb runs in your infrastructure. Nothing here phones home.</div>
      </div>
      {rel.data?.upgrade ? <Button variant="primary" size="lg" onClick={() => setUpgradeOpen(true)}>Upgrade to {rel.data.upgrade.version}</Button> : null}
    </div>
  );

  if (!isAdmin) {
    return (
      <div className="screen">
        <div style={{ padding: '18px 20px 50px', maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 24 }}>
          {header}
          <Callout kind="info" title="Admins only">Service health and release history are visible to Admins and Owners. Feature flags are listed below for reference.</Callout>
          {flags.data ? <FlagsPanel data={flags.data} canEdit={false} /> : flags.isLoading ? <Loading /> : <ErrorBox error={flags.error} />}
        </div>
      </div>
    );
  }

  if (ov.isLoading || svc.isLoading) return <Loading />;
  if (ov.error) return <ErrorBox error={ov.error} onRetry={() => ov.refetch()} />;
  const o = ov.data!;
  const m = members.data;
  const oldest = o.pendingMigrations[0];

  return (
    <div className="screen">
      <div style={{ padding: '18px 20px 50px', maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 24 }}>
        {header}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(148px,1fr))', gap: 10 }}>
          <Kpi value={o.version} label="Version" note={o.latest ? `${o.latest} available` : rel.data?.feed.configured ? 'current' : 'current · no release feed configured'} tone={o.latest ? 'var(--state-running)' : undefined} />
          <Kpi value={uptime(o.uptimeS)} label="Uptime" note={`this process · started ${dateTime(o.startedAt).slice(5)}`} />
          <Kpi value={m ? String(m.active + m.invited) : '—'} label="Members" note={m ? `${m.active} active · ${m.invited} invited · ${m.service} service` : 'no member limit'} />
          <Kpi value={bytes(o.metaDb.sizeBytes)} label="Comb database" note={`audit trail is ${bytes(o.metaDb.auditBytes)} of it`} />
          <Kpi value={oldest ? `${o.pendingMigrations.length} pending` : 'none'} label="Migrations" note={oldest ? <>oldest unapplied: <span style={{ fontFamily: MONO }} title={o.pendingMigrations.join(', ')}>{oldest.replace(/\.sql$/, '')}</span> · runs on next start</> : 'schema is up to date'} tone={oldest ? 'var(--state-running)' : undefined} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={SECTION}>Services</div>
          {svc.error ? <ErrorBox error={svc.error} /> : (
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: SVC_T, minWidth: 700, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...SECTION }}>
                <div style={{ padding: '5px 10px', borderRight: '1px solid var(--border-subtle)' }}>Service</div>
                <div style={{ padding: '5px 10px', borderRight: '1px solid var(--border-subtle)' }}>Version</div>
                <div style={{ padding: '5px 10px', borderRight: '1px solid var(--border-subtle)', textAlign: 'right' }}>Replicas</div>
                <div style={{ padding: '5px 10px', borderRight: '1px solid var(--border-subtle)' }}>Load</div>
                <div style={{ padding: '5px 10px' }}>State</div>
              </div>
              {svc.data!.map((s, i, arr) => {
                const pct = s.load === null ? 0 : Math.round(s.load * 100);
                return (
                  <div key={s.name} className="row-hover" style={{ display: 'grid', gridTemplateColumns: SVC_T, minWidth: 700, height: 42, borderBottom: i < arr.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
                      <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.role}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>{s.version}</div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>{s.replicas}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderRight: '1px solid var(--border-subtle)' }}>
                      <div style={{ flex: 1, minWidth: 40, height: 6, background: 'var(--bg-inset)', borderRadius: 3, overflow: 'hidden' }}>
                        <span style={{ display: 'block', height: '100%', width: Math.max(s.load ? 2 : 0, pct) + '%', background: pct > 80 ? 'var(--state-error)' : pct > 60 ? 'var(--state-running)' : 'var(--state-success)' }} />
                      </div>
                      <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{s.loadLabel}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px' }}>
                      <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', whiteSpace: 'nowrap', color: stateColor(s.state), textTransform: 'uppercase' }}>{s.state}</span>
                      <span className="spacer" />
                      <button onClick={() => setLogsFor(s)} style={{ fontSize: 11, color: 'var(--state-info)', whiteSpace: 'nowrap' }}>{s.name === 'comb-api' || s.name === 'comb-worker' ? 'logs' : 'details'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>Measured live from this process: event-loop utilisation for the API, due jobs for the worker, connections against max_connections for the metadata database.</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={SECTION}>Feature flags</div>
          {flags.data ? <FlagsPanel data={flags.data} canEdit={isAdmin} /> : <Loading />}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={SECTION}>Release history</div>
          {rel.data ? (
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
              {rel.data.releases.length ? rel.data.releases.map((r, i) => (
                <div key={r.version} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', minHeight: 30, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
                  <span style={{ fontFamily: MONO, fontSize: 12, width: 66, flex: 'none' }}>{r.version}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', width: 88, flex: 'none' }}>{r.date || '—'}</span>
                  <span style={{ fontSize: 12, flex: 1, minWidth: 0 }}>{r.notes}</span>
                  <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', whiteSpace: 'nowrap', color: r.state === 'available' ? 'var(--state-running)' : r.state === 'current' ? 'var(--state-success)' : 'var(--text-muted)', textTransform: 'uppercase' }}>{r.state === 'earlier' ? 'earlier' : r.state === 'current' ? 'installed' : 'available'}</span>
                </div>
              )) : <Empty title="No release notes" body="CHANGELOG.md was not found next to this build." />}
            </div>
          ) : rel.error ? <ErrorBox error={rel.error} /> : <Loading />}
          <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>
            {rel.data?.feed.error ? <span style={{ color: 'var(--state-running)' }}>{rel.data.feed.error}. </span> : null}
            {rel.data?.feed.configured ? 'Newer versions come from the local release feed file (COMB_RELEASE_FEED). ' : 'Comb never checks the internet for updates. Point COMB_RELEASE_FEED at a JSON file to see newer releases here. '}
            Upgrades are applied by your deploy tooling, not from this screen.
          </div>
        </div>
      </div>

      {logsFor ? <LogsModal svc={logsFor} onClose={() => setLogsFor(null)} /> : null}
      {upgradeOpen && rel.data?.upgrade ? <UpgradeModal up={rel.data.upgrade} current={rel.data.current} onClose={() => setUpgradeOpen(false)} /> : null}
    </div>
  );
}

function FlagsPanel({ data, canEdit }: { data: Flags; canEdit: boolean }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (v: { key: FlagKey; on: boolean }) => api.put<Flags>('/deploy/flags', v),
    onSuccess: (d) => qc.setQueryData(['deploy-flags'], d),
    onError: (e) => toastError(e, 'Could not change the flag'),
  });
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, padding: 11, display: 'flex', flexDirection: 'column', gap: 11 }}>
      {data.defs.map((f) => (
        <div key={f.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
            <span style={{ fontFamily: MONO, fontSize: 12 }}>{f.key}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{f.hint}</span>
          </div>
          <Toggle on={data.flags[f.key]} disabled={!canEdit || set.isPending} onChange={(on) => set.mutate({ key: f.key, on })} title={canEdit ? undefined : 'Admins only'} />
        </div>
      ))}
    </div>
  );
}

function LogsModal({ svc, onClose }: { svc: ServiceRow; onClose: () => void }) {
  const withLogs = svc.name === 'comb-api' || svc.name === 'comb-worker';
  const q = useQuery({ queryKey: ['deploy-logs'], queryFn: () => api.get<{ lines: Array<{ at: string; level: string; text: string }> }>('/deploy/logs'), enabled: withLogs, refetchInterval: 5000 });
  return (
    <Modal title={svc.name} onClose={onClose} width={760} footer={<><span className="spacer" /><Button onClick={onClose}>Close</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px' }}>
          {svc.facts.map(([k, v]) => (
            <React.Fragment key={k}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{k}</span>
              <span style={{ fontFamily: MONO, fontSize: 12 }}>{v}</span>
            </React.Fragment>
          ))}
        </div>
        {withLogs ? (
          <>
            <div style={SECTION}>Warnings and errors · last 200 · this process</div>
            <div style={{ background: 'var(--bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 3, maxHeight: 340, overflow: 'auto', padding: '6px 0' }}>
              {q.isLoading ? <Loading /> : q.data?.lines.length ? q.data.lines.slice().reverse().map((l, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '1px 10px', fontFamily: MONO, fontSize: 11, lineHeight: '17px' }}>
                  <span style={{ color: 'var(--text-muted)', flex: 'none' }}>{l.at.slice(11, 19)}</span>
                  <span style={{ color: l.level === 'error' ? 'var(--state-error)' : 'var(--state-running)', flex: 'none', width: 38 }}>{l.level}</span>
                  <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{l.text}</span>
                </div>
              )) : <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>No warnings or errors since this process started.</div>}
            </div>
            <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--text-muted)' }}>Kept in memory only, redacted for connection strings, tokens and keys. Request bodies are never logged. The worker runs inside the API process, so both share this buffer. Structured request logs go to stdout for your log shipper.</div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function UpgradeModal({ up, current, onClose }: { up: { version: string; docker: string; helm: string }; current: string; onClose: () => void }) {
  const [mode, setMode] = useState<'docker' | 'helm'>('docker');
  const toast = useApp((s) => s.toast);
  const text = up[mode];
  return (
    <Modal title={`Upgrade ${current} → ${up.version}`} onClose={onClose} width={640}
      footer={<><span className="spacer" /><Button onClick={() => { void navigator.clipboard?.writeText(text).then(() => toast('Commands copied')); }}>Copy</Button><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Callout kind="info" title="Comb does not update itself">Self-updating a security tool from its own UI is a bad idea: anyone who takes over an admin session could swap the binary. Run the upgrade with the same tooling that deployed Comb. Migrations run on start; take a backup of the metadata database first.</Callout>
        <Seg options={['docker', 'helm'] as const} value={mode} onChange={setMode} labels={{ docker: 'Docker Compose', helm: 'Helm' }} />
        <div style={{ background: 'var(--bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 3 }}><CodeLines text={text} /></div>
      </div>
    </Modal>
  );
}

