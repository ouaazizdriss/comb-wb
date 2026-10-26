import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BackupOverview, BackupRow, OpsTask } from '@comb/shared/src/ops.ts';
import type { Tab } from '../lib/store.ts';
import { useApp, useConn, toastError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { withConfirm } from '../lib/confirm.ts';
import { ago, bytes, dateTime } from '../lib/format.ts';
import { Button, Callout, COND, ErrorBox, Loading, MONO } from '../ui/index.tsx';

/*
 * Backups & recovery (mockup isBackupTab). Honest about the backend: with pgBackRest the PITR
 * window is continuous; with built-in logical backups (pg_dump) the slider snaps to dumps.
 * Every long action is a server job; the screen polls while one is queued or running.
 */

const condLabel: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };

function dur(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return (ms < 10_000 ? (ms / 1000).toFixed(1) : s) + ' s';
  return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
}

function ageShort(iso: string | null): string {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min';
  if (s < 86400 * 2) return Math.round(s / 3600) + ' h';
  return Math.round(s / 86400) + ' days';
}

const TASK_LABEL: Record<OpsTask['kind'], string> = { backup: 'Backup', verify: 'Verify restore', restore_scratch: 'Restore to scratch', restore_inplace: 'Restore in place' };

function Kpi({ value, label, note, tone }: { value: string; label: string; note: string; tone: 'ok' | 'warn' | 'err' }) {
  const c = tone === 'ok' ? 'var(--state-success)' : tone === 'warn' ? 'var(--state-running)' : 'var(--state-error)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 11px', border: '1px solid var(--border-subtle)', borderLeft: '3px solid ' + c, borderRadius: 3, background: 'var(--bg-raised)', minWidth: 0 }}>
      <span style={{ fontFamily: MONO, fontSize: 22, lineHeight: '28px', fontWeight: 500, color: tone === 'ok' ? 'var(--text-primary)' : c }}>{value}</span>
      <span style={condLabel}>{label}</span>
      <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--text-muted)' }}>{note}</span>
    </div>
  );
}

function verifiedCell(b: BackupRow): { text: string; color: string; title: string } {
  if (b.status === 'running') return { text: '… running', color: 'var(--state-info)', title: '' };
  if (b.status === 'error') return { text: '✕ failed', color: 'var(--state-error)', title: b.error ?? '' };
  if (b.status === 'expired') return { text: 'expired', color: 'var(--text-muted)', title: 'Removed by retention' };
  if (b.verified === true) return { text: '✓ restored', color: 'var(--state-success)', title: b.verifyNote ?? '' };
  if (b.verified === false) return { text: '✕ restore failed', color: 'var(--state-error)', title: b.verifyNote ?? '' };
  if (b.verifyNote) return { text: '⚠ not verified', color: 'var(--state-running)', title: b.verifyNote };
  return { text: '⚠ not drilled', color: 'var(--state-running)', title: 'Not restored yet. The nightly job restores the newest backup.' };
}

/** Backups & recovery. */
export default function BackupScreen({ tab }: { tab: Tab }) {
  void tab;
  const conn = useConn();
  const me = useApp((s) => s.me);
  const qc = useQueryClient();
  const [sel, setSel] = useState<number | null>(null);
  const [pct, setPct] = useState(100);
  const ov = useQuery({
    queryKey: ['backup', conn.id],
    queryFn: () => api.get<BackupOverview>(`/backup/${conn.id}`),
    refetchInterval: (q) => ((q.state.data as BackupOverview | undefined)?.tasks.some((t) => t.status === 'queued' || t.status === 'running') ? 2500 : 30_000),
  });
  const o = ov.data;

  // Toast when a task this screen saw running finishes.
  const seen = useRef(new Map<number, string>());
  useEffect(() => {
    if (!o) return;
    for (const t of o.tasks) {
      const before = seen.current.get(t.id);
      if (before && (before === 'queued' || before === 'running') && (t.status === 'ok' || t.status === 'error')) {
        const r = t.result ?? {};
        if (t.status === 'error') useApp.getState().toast(`${TASK_LABEL[t.kind]} failed`, t.error ?? '', 'error');
        else if (t.kind === 'restore_scratch') useApp.getState().toast('Scratch restore ready', `${r.connectionName} is in your launcher, tagged DEV and read-only (${r.tables} tables).`, 'success');
        else if (t.kind === 'backup') useApp.getState().toast('Backup finished', `${bytes(Number(r.sizeBytes ?? 0))} · ${dur(Number(r.durationMs ?? 0))} · sha256 ${String(r.sha256 ?? '').slice(0, 12)}…`, 'success');
        else useApp.getState().toast(`${TASK_LABEL[t.kind]} finished`, `${r.tables ?? ''} tables`, 'success');
      }
      seen.current.set(t.id, t.status);
    }
  }, [o]);

  const isAdmin = conn.level === 'admin';
  const isOwner = me?.role === 'Owner';
  const logical = o?.backend === 'logical';
  const points = o?.points ?? [];
  const usable = (o?.backups ?? []).filter((b) => b.status !== 'expired');

  // Slider: logical → snap to dumps; pgBackRest → continuous over the WAL window.
  const idx = points.length ? Math.round((pct / 100) * (points.length - 1)) : -1;
  const chosen = logical && idx >= 0 ? points[idx] : null;
  const chosenId = sel ?? chosen?.id ?? null;
  const winStart = o?.window ? new Date(o.window.start).getTime() : 0;
  const winEnd = o?.window ? new Date(o.window.end).getTime() : 0;
  const posOf = (iso: string) => (winEnd > winStart ? ((new Date(iso).getTime() - winStart) / (winEnd - winStart)) * 100 : 100);
  const chosenTime = logical ? (chosen ? chosen.at : null) : o?.window ? new Date(winStart + ((winEnd - winStart) * pct) / 100).toISOString() : null;
  const fillPct = logical && chosen ? posOf(chosen.at) : pct;
  const utc = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—');

  const refresh = () => qc.invalidateQueries({ queryKey: ['backup', conn.id] });
  const act = async (fn: () => Promise<unknown>, title: string, sub: string) => {
    try {
      const r = await fn();
      if (r) useApp.getState().toast(title, sub, 'info');
      refresh();
    } catch (e) {
      toastError(e, title.replace(/ (queued|started)$/, '') + ' not started');
    }
  };
  const backupNow = () => act(() => api.post(`/backup/${conn.id}/run`, { kind: logical ? 'logical' : 'full' }), 'Backup started',
    logical ? `pg_dump --format=custom of ${conn.db}; checksum and size are recorded when it finishes.` : 'pgbackrest full backup is running on the Comb server.');
  const verify = (id: number) => act(() => api.post(`/backup/${conn.id}/verify`, { backupId: id }), 'Verification queued', 'Restores into a scratch database, counts tables, drops it.');
  const scratch = () => chosenId && act(() => api.post(`/backup/${conn.id}/restore-scratch`, { backupId: chosenId }), 'Scratch restore queued',
    `${utc(chosenTime)} → ${conn.db}_restore_…  It appears in your launcher when it is ready, tagged DEV and read-only.`);
  const inPlace = () => chosenId && act(() => withConfirm((confirm) => api.post(`/backup/${conn.id}/restore-inplace`, { backupId: chosenId, confirm }), {
    title: `Restore ${conn.name} in place`,
    body: 'Every object in the dump is dropped and recreated with the rows it had when the backup was taken. Anything written to those tables since then is gone. The restore runs in one transaction: if any step fails, nothing changes.',
  }), 'Restore started', `Restoring ${conn.db} to ${utc(chosenTime)}. Recorded in the audit trail.`);

  const newest = usable.find((b) => b.status === 'ok');
  const lastVerified = usable.filter((b) => b.verifiedAt).sort((a, b) => (a.verifiedAt! < b.verifiedAt! ? 1 : -1))[0];
  const totalSize = usable.filter((b) => b.status === 'ok').reduce((s, b) => s + (b.sizeBytes ?? 0), 0);
  const okCount = usable.filter((b) => b.status === 'ok').length;
  const rpoAge = newest ? (Date.now() - new Date(newest.finishedAt ?? newest.startedAt).getTime()) / 3600_000 : null;
  const running = o?.tasks.filter((t) => t.status === 'queued' || t.status === 'running') ?? [];

  const T = '140px 86px 92px 92px 140px minmax(160px,1fr) 64px';
  const cell: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, overflow: 'hidden', whiteSpace: 'nowrap' };
  const numCell: React.CSSProperties = { ...cell, justifyContent: 'flex-end', color: 'var(--text-secondary)' };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', height: '100%' }}>
      <div style={{ padding: '16px 18px 50px', maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 400px' }}>
            <div style={{ fontSize: 20, lineHeight: '26px', fontWeight: 600 }}>Backups &amp; recovery</div>
            <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--text-secondary)' }}>
              {o && !logical ? 'Continuous WAL archiving with pgBackRest. ' : 'Logical backups with pg_dump, checked by restoring them. '}
              Recovery is the only number that matters here, so it is the one on top.
            </div>
          </div>
          <Button size="lg" onClick={backupNow} disabled={!isAdmin || running.some((t) => t.kind === 'backup') || (logical && !o?.capabilities.pgDump)}
            title={!isAdmin ? `Needs admin access on ${conn.name}` : ''}>{logical ? 'Backup now' : 'Base backup now'}</Button>
        </div>

        {ov.isLoading ? <Loading /> : ov.error ? <ErrorBox error={ov.error} onRetry={() => ov.refetch()} /> : null}
        {o?.capabilities.notes.map((n) => <Callout key={n} kind={/not found|lacks|cannot/.test(n) ? 'warn' : 'info'}>{n}</Callout>)}

        {o ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 }}>
            <Kpi value={newest ? ageShort(newest.finishedAt ?? newest.startedAt) : 'none'} label="Recovery point"
              note={newest ? (logical ? `worst-case data loss · newest dump ${dateTime(newest.finishedAt)}` : 'newest backup; WAL replays to now') : 'no backup yet: everything is at risk'}
              tone={rpoAge === null ? 'err' : rpoAge > 36 ? 'warn' : 'ok'} />
            <Kpi value={lastVerified ? (lastVerified.verified ? '✓' : '✕') : '—'} label="Restore verified"
              note={lastVerified ? `${lastVerified.verifyNote ?? ''} · ${ago(lastVerified.verifiedAt)}` : o.capabilities.createdb === false ? 'cannot verify: needs CREATEDB' : 'nightly drill at 03:17 UTC · not run yet'}
              tone={!lastVerified ? 'warn' : lastVerified.verified ? 'ok' : 'err'} />
            <Kpi value={String(okCount)} label="Backups" note={`${bytes(totalSize)} on ${logical ? 'the Comb server' : 'the pgBackRest repository'}`} tone={okCount ? 'ok' : 'warn'} />
            <Kpi value={logical ? `last ${o.retention.keepLast}` : 'repo'} label="Retention" note={logical ? `older dumps are deleted · ${o.capabilities.dir}` : 'set by repo1-retention-full in pgbackrest.conf'} tone="ok" />
          </div>
        ) : null}

        {running.length || o?.tasks.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={condLabel}>Jobs · last 24 h</div>
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
              {o!.tasks.slice(0, 6).map((t, i) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 30, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)', width: 92, flex: 'none', whiteSpace: 'nowrap' }}>{dateTime(t.createdAt).slice(5)}</span>
                  <span style={{ fontSize: 12, width: 130, flex: 'none' }}>{TASK_LABEL[t.kind]}</span>
                  <span style={{ ...condLabel, width: 64, flex: 'none', color: t.status === 'ok' ? 'var(--state-success)' : t.status === 'error' ? 'var(--state-error)' : 'var(--state-info)',
                    animation: t.status === 'running' ? 'combpulse 1.6s ease-in-out infinite' : undefined }}>{t.status}</span>
                  <span title={t.error ?? ''} style={{ fontSize: 12, color: t.error ? 'var(--state-error)' : 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.error ?? (t.result ? (t.kind === 'restore_scratch' ? `→ ${t.result.connectionName} (${t.result.tables} tables)` : t.kind === 'backup' ? `${bytes(Number(t.result.sizeBytes ?? 0))} · ${dur(Number(t.result.durationMs ?? 0))}` : `${t.result.tables ?? ''} tables`) : '')}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>{t.createdBy}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {o ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={condLabel}>{logical ? 'Restore points' : 'Point-in-time recovery window'}</div>
            <div style={{ padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 3, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {o.window ? (
                <>
                  <div style={{ position: 'relative', height: 34 }}>
                    <div style={{ position: 'absolute', left: 0, right: 0, top: 14, height: 6, background: 'var(--bg-inset)', borderRadius: 3 }} />
                    <div style={{ position: 'absolute', left: 0, top: 14, height: 6, width: fillPct + '%', background: 'var(--state-info)', borderRadius: 3 }} />
                    <div style={{ position: 'absolute', left: `calc(${fillPct}% - 1px)`, top: 6, width: 2, height: 22, background: 'var(--text-primary)' }} />
                    {points.map((p) => (
                      <div key={p.id} title={'backup ' + utc(p.at)} style={{ position: 'absolute', left: posOf(p.at) + '%', top: 10, width: 6, height: 14, marginLeft: -3, background: 'var(--border-strong)', border: '1px solid var(--bg-base)' }} />
                    ))}
                  </div>
                  <input type="range" min={0} max={100} step={logical && points.length > 1 ? 100 / (points.length - 1) : 1} value={pct}
                    onChange={(e) => { setPct(Number(e.target.value)); setSel(null); }} style={{ width: '100%', accentColor: 'var(--text-primary)' }} aria-label="Restore point" />
                </>
              ) : <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No backup yet, so there is nothing to restore to. Take one with “Backup now”.</div>}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: MONO, fontSize: 13 }}>{utc(chosenTime)}</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {logical ? (points.length ? `dump ${idx + 1} of ${points.length} · logical backups restore to the moment a dump was taken; there is no WAL in between, so the slider snaps to backups` : '')
                    : 'pgBackRest restores need the server stopped; Comb shows the command to run on the database host'}
                </span>
                <span style={{ flex: 1 }} />
                <Button size="md" disabled={!isAdmin || !chosenId || !logical || o.capabilities.createdb === false} onClick={scratch}
                  title={!logical ? 'Run pgbackrest restore with --type=time on a spare host' : o.capabilities.createdb === false ? 'Needs CREATEDB' : ''}>Restore to a scratch connection</Button>
                <Button size="md" variant="danger" style={{ color: 'var(--text-inverse)' }} disabled={!isOwner || !isAdmin || !chosenId || !logical || conn.readOnly} onClick={inPlace}
                  title={conn.readOnly ? `${conn.name} is read-only` : !isOwner ? 'Owner only' : ''}>Restore in place…</Button>
              </div>
              {!logical && chosenTime && o.capabilities.stanza ? (
                <code style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-inset)', padding: '6px 8px', borderRadius: 3 }}>
                  pgbackrest --stanza={o.capabilities.stanza} --delta --type=time "--target={chosenTime.replace('T', ' ').replace('Z', '+00')}" --target-action=promote restore
                </code>
              ) : null}
            </div>
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>
              Restoring in place replaces the objects in {conn.db} with their backed-up state. Comb requires the connection name typed out, only the Owner can do it, and it is recorded in the trail.
            </div>
          </div>
        ) : null}

        {o ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={condLabel}>Backup history</div>
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: T, minWidth: 800, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...condLabel }}>
                {['Taken', 'Kind', 'Size', 'Duration', 'Verified', 'Destination', ''].map((h, i) => (
                  <div key={i} style={{ padding: '5px 10px', borderRight: i < 6 ? '1px solid var(--border-subtle)' : 'none', textAlign: i === 2 || i === 3 ? 'right' : 'left' }}>{h}</div>
                ))}
              </div>
              {o.backups.length === 0 ? <div style={{ padding: '18px 12px', fontSize: 12, color: 'var(--text-muted)' }}>No backups of {conn.name} yet.</div> : null}
              {o.backups.map((b, i) => {
                const v = verifiedCell(b);
                const selected = chosenId === b.id;
                return (
                  <div key={b.id} className="row-hover" onClick={() => { if (b.status === 'ok' && b.backend === 'logical') { setSel(b.id); const k = points.findIndex((p) => p.id === b.id); if (k >= 0) setPct(points.length > 1 ? (k / (points.length - 1)) * 100 : 100); } }}
                    style={{ display: 'grid', gridTemplateColumns: T, minWidth: 800, height: 32, borderBottom: i < o.backups.length - 1 ? '1px solid var(--border-subtle)' : 'none', cursor: 'pointer',
                      background: selected ? 'var(--bg-selected)' : undefined, opacity: b.status === 'expired' ? 0.55 : 1 }}>
                    <div style={cell}>{dateTime(b.startedAt).slice(5)}</div>
                    <div style={cell}><span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{b.kind}</span></div>
                    <div style={numCell}>{bytes(b.sizeBytes)}</div>
                    <div style={numCell}>{dur(b.durationMs)}</div>
                    <div style={cell} title={v.title}><span style={{ color: v.color }}>{v.text}</span></div>
                    <div style={{ ...cell, color: 'var(--text-muted)', textOverflow: 'ellipsis' }} title={`${b.destination ?? ''}${b.sha256 ? '\nsha256 ' + b.sha256 : ''}${b.error ? '\n' + b.error : ''}`}>
                      {b.status === 'error' ? <span style={{ color: 'var(--state-error)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.error}</span>
                        : <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.destination}</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px' }}>
                      {isAdmin && b.backend === 'logical' && b.status === 'ok' ? (
                        <button onClick={(e) => { e.stopPropagation(); verify(b.id); }} style={{ fontSize: 11, color: 'var(--state-info)' }} disabled={running.some((t) => t.kind === 'verify' && t.backupId === b.id)}>verify</button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>
              A backup nobody restored is a rumour. Comb restores the newest backup into a scratch database nightly, counts its tables against the dump, drops it, and reports whether it came up.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
