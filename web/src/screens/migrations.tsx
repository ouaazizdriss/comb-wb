import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tab } from '../lib/store.ts';
import { useApp, useConn, toastError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { withConfirm } from '../lib/confirm.ts';
import { dateTime, ms as fmtMs } from '../lib/format.ts';
import { Button, Seg, Modal, TextInput, Label, Loading, ErrorBox, Empty, IDC, MONO, COND } from '../ui/index.tsx';

/** Migrations: versioned up/down scripts, dry runs, lock analysis, drift and promotion across environments. */

type MState = 'pending' | 'applied' | 'failed' | 'awaiting approval';
interface MigItem { id: string; version: string; name: string; author: string; createdAt: string; statements: number; risk: string; state: MState; appliedAt: string | null; error: string | null; drift: boolean; approvalId: number | null }
interface MigList {
  project: string; connection: { id: string; name: string; env: string; readOnly: boolean; requireApproval: boolean }; level: string; canAdmin: boolean;
  migrations: MigItem[]; summary: { applied: number; pending: number; failed: number; awaiting: number; drift: number };
}
interface Warning { title: string; body: string; severity: 'warn' | 'info' }
interface DiffLine { sign: '+' | '-' | '~'; text: string; note: string }
interface MigDetail {
  id: string; version: string; name: string; up: string; down: string; author: string; createdAt: string; state: MState; appliedAt: string | null; appliedBy: string | null;
  error: string | null; ms: number | null; approvalId: number | null; drift: boolean; canEdit: boolean;
  analysis: { statements: number; lock: string; risk: string; estSeconds: number | null; est: string; reversible: boolean; warnings: Warning[]; noTxn: boolean };
  envs: Array<{ id: string; name: string; color: string; env: string; state: MState; at: string | null; drift: boolean }>;
}
interface DryRun { ok: boolean; ms: number; statements: Array<{ index: number; command: string; ok: boolean; ms: number; rowCount: number | null; error?: string; line?: number }>; diff: DiffLine[]; note: string }
interface Drift { baseline: { version: string; at: string } | null; edited: Array<{ version: string; appliedAt: string }>; schema: DiffLine[]; checked: { tables: number; indexes: number; constraints: number }; clean: boolean }

const sectionLabel: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };
const stateColor = (s: MState) => (s === 'applied' ? 'var(--state-success)' : s === 'failed' ? 'var(--state-error)' : s === 'awaiting approval' ? 'var(--state-info)' : 'var(--state-running)');

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function DiffRows({ lines, empty }: { lines: DiffLine[]; empty: string }) {
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
      {lines.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', minHeight: 28, borderTop: i ? '1px solid var(--border-subtle)' : 'none',
          background: d.sign === '+' ? 'color-mix(in oklab, var(--state-success) 8%, transparent)' : d.sign === '-' ? 'color-mix(in oklab, var(--danger) 8%, transparent)' : 'transparent' }}>
          <span style={{ fontFamily: MONO, fontSize: 12, width: 8, flex: 'none', color: d.sign === '+' ? 'var(--state-success)' : d.sign === '-' ? 'var(--danger)' : 'var(--state-running)' }}>{d.sign}</span>
          <span title={d.text} style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.text}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{d.note}</span>
        </div>
      ))}
      {!lines.length ? <div style={{ padding: '10px', fontSize: 12, color: 'var(--text-muted)' }}>{empty}</div> : null}
    </div>
  );
}

export default function MigrationsScreen({ tab }: { tab: Tab }) {
  const conn = useConn();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const updateTab = useApp((s) => s.updateTab);
  const [editor, setEditor] = useState<null | { id?: string; version: string; name: string; up: string; down: string }>(null);
  const [drift, setDrift] = useState<Drift | null>(null);
  const [checking, setChecking] = useState(false);
  const list = useQuery({ queryKey: ['migrations', conn.id], queryFn: () => api.get<MigList>(`/migrations/${conn.id}`) });
  const migs = list.data?.migrations ?? [];
  const sel: string | undefined = tab.params?.sel;
  const selId = sel && migs.some((m) => m.id === sel) ? sel : migs[0]?.id;
  const detail = useQuery({ queryKey: ['migration', conn.id, selId], queryFn: () => api.get<MigDetail>(`/migrations/${conn.id}/${selId}`), enabled: !!selId, retry: false });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['migrations', conn.id] }); qc.invalidateQueries({ queryKey: ['migration', conn.id] }); };
  const s = list.data?.summary;

  const checkDrift = async () => {
    setChecking(true);
    try {
      const d = await api.post<Drift>(`/migrations/${conn.id}/drift`, {});
      if (d.clean) toast('No drift', d.baseline ? `Live catalog matches the applied set. Checked ${d.checked.tables} relations, ${d.checked.indexes} indexes, ${d.checked.constraints} constraints.` : 'Nothing applied here yet, so there is no baseline to compare.', 'success');
      else setDrift(d);
    } catch (e) { toastError(e, 'Drift check failed'); } finally { setChecking(false); }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflowX: 'auto' }}>
        <span style={{ ...sectionLabel, whiteSpace: 'nowrap', flex: 'none' }}>Migrations</span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none' }}>
          {s ? [`${s.applied} applied`, `${s.pending} pending`, s.awaiting ? `${s.awaiting} awaiting approval` : null, s.failed ? `${s.failed} failed` : null, s.drift ? `${s.drift} drifted` : 'no drift'].filter(Boolean).join(' · ') : '…'}
        </span>
        {list.data ? <span title="Connections that share a project share one migration set (dev → staging → prod)" style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>project {list.data.project}</span> : null}
        <span style={{ flex: 1, minWidth: 8 }} />
        {list.data?.canAdmin ? <Button size="sm" variant="ghost" onClick={async () => {
          const p = window.prompt(`Migration project for ${conn.name} (connections in one project share migrations):`, list.data!.project);
          if (!p) return;
          try { await api.put(`/migrations/${conn.id}/project`, { project: p }); refresh(); } catch (e) { toastError(e); }
        }}>Project…</Button> : null}
        <Button size="sm" onClick={() => setEditor({ version: stamp(), name: '', up: '', down: '' })} disabled={list.data ? list.data.level === 'read' : true}
          title={list.data?.level === 'read' ? `You have read access to ${conn.name}` : 'Comb writes the version stamp; you write the statements.'}>+ New</Button>
        <Button size="sm" onClick={checkDrift} disabled={checking}>{checking ? 'Checking…' : '⟳ Check drift'}</Button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ width: 290, flex: 'none', borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflow: 'auto' }}>
          {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={() => list.refetch()} /> : null}
          {migs.map((m) => (
            <div key={m.id} className="row-hover" onClick={() => updateTab(tab.id, { params: { sel: m.id } })}
              style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)', background: selId === m.id ? 'var(--bg-selected)' : 'transparent' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', flex: 'none', background: stateColor(m.state) }} />
                <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.version}</span>
                <span style={{ flex: 1 }} />
                {m.drift ? <span title="Up SQL changed after it was applied" style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--state-error)' }}>DRIFT</span> : null}
                <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: stateColor(m.state), whiteSpace: 'nowrap', textTransform: 'uppercase' }}>{m.state === 'awaiting approval' ? 'APPROVAL' : m.state}</span>
              </div>
              <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>{m.author.split('@')[0]} · {m.statements} {m.statements === 1 ? 'statement' : 'statements'}</span>
            </div>
          ))}
          {list.data && !migs.length ? <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No migrations in project {list.data.project} yet.</div> : null}
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {!selId ? (
            <Empty title="Migrations" body="Versioned SQL scripts with an up and a down. Comb tracks what is applied on each connection in its own metadata, dry-runs inside a rolled-back transaction and warns about locks before anything touches the catalog." />
          ) : detail.isLoading ? <Loading /> : detail.error ? <ErrorBox error={detail.error} /> : detail.data && list.data ? (
            <Detail key={detail.data.id + detail.data.up.length} m={detail.data} list={list.data} onChanged={refresh}
              onEdit={() => setEditor({ id: detail.data!.id, version: detail.data!.version, name: detail.data!.name, up: detail.data!.up, down: detail.data!.down })}
              onDeleted={() => { updateTab(tab.id, { params: { sel: undefined } }); refresh(); }} />
          ) : null}
        </div>
      </div>
      {editor ? <Editor init={editor} connId={conn.id} onClose={() => setEditor(null)} onSaved={(id) => { setEditor(null); updateTab(tab.id, { params: { sel: id } }); refresh(); }} /> : null}
      {drift ? (
        <Modal title={`Drift on ${conn.name}`} onClose={() => setDrift(null)} width={720} footer={<><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Checked {drift.checked.tables} relations, {drift.checked.indexes} indexes, {drift.checked.constraints} constraints.</span><span className="spacer" /><Button onClick={() => setDrift(null)}>Close</Button></>}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {drift.edited.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Label>Edited after apply</Label>
                {drift.edited.map((e) => <div key={e.version} style={{ fontFamily: MONO, fontSize: 12 }}>{e.version} <span style={{ color: 'var(--text-muted)' }}>applied {dateTime(e.appliedAt)} — the stored up SQL no longer matches its checksum</span></div>)}
              </div>
            ) : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Label>Live catalog vs. the snapshot recorded after {drift.baseline ? drift.baseline.version : '—'}</Label>
              <DiffRows lines={drift.schema} empty="The live catalog matches the snapshot." />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Differences are changes made outside migrations (or by another tool) since the last apply.</span>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function Detail({ m, list, onChanged, onEdit, onDeleted }: { m: MigDetail; list: MigList; onChanged: () => void; onEdit: () => void; onDeleted: () => void }) {
  const conn = useConn();
  const toast = useApp((s) => s.toast);
  const [dir, setDir] = useState<'Up' | 'Down'>('Up');
  const [dry, setDry] = useState<DryRun | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const blocked = list.connection.readOnly || list.level === 'read';
  const blockedWhy = list.connection.readOnly ? `${conn.name} is read-only. Migrations need a writable connection.` : `You have read access to ${conn.name}.`;

  const dryRun = async () => {
    setBusy('dry');
    try {
      const r = await api.post<DryRun>(`/migrations/${conn.id}/${m.id}/dry-run`, { direction: dir.toLowerCase() });
      setDry(r);
      toast(r.ok ? 'Dry run passed' : 'Dry run failed', r.note, r.ok ? 'success' : 'error');
    } catch (e) { toastError(e, 'Dry run refused'); } finally { setBusy(null); }
  };
  const run = async (kind: 'apply' | 'rollback') => {
    if (blocked) { toast('Blocked', blockedWhy, 'error'); return; }
    setBusy(kind);
    try {
      const r = await withConfirm((confirm) => api.post<{ state: string; approvalId?: number; ms?: number }>(`/migrations/${conn.id}/${m.id}/${kind}`, { confirm }),
        { title: `${kind === 'apply' ? 'Apply' : 'Roll back'} ${m.version} on ${conn.name}`, body: `${conn.name} is production. Type the version to ${kind === 'apply' ? 'run the up SQL' : 'run the down SQL'}.` });
      if (!r) return;
      if (r.approvalId) toast('Sent for approval', `ap-${r.approvalId}: an approver must run it. The migration shows AWAITING APPROVAL until then.`, 'info');
      else toast(kind === 'apply' ? `Applied ${m.version}` : `Rolled back ${m.version}`, `${conn.name} · ${fmtMs(r.ms ?? 0)}`, 'success');
      onChanged();
    } catch (e) { toastError(e, kind === 'apply' ? 'Apply failed' : 'Rollback failed'); onChanged(); } finally { setBusy(null); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete migration ${m.version}?`)) return;
    try { await api.del(`/migrations/${conn.id}/${m.id}`); toast('Deleted ' + m.version); onDeleted(); } catch (e) { toastError(e); }
  };

  const a = m.analysis;
  const facts: Array<[string, string, 'text' | 'num', boolean]> = [
    ['Author', m.author.split('@')[0], 'text', false],
    ['Statements', String(a.statements), 'num', false],
    ['Est. duration', a.est, 'num', (a.estSeconds ?? 0) >= 5],
    ['Lock level', a.lock === 'none' ? 'none' : a.lock, 'text', a.risk !== 'safe'],
    ['Reversible', a.reversible ? 'yes' : 'no down SQL', 'text', !a.reversible],
  ];
  const text = dir === 'Up' ? m.up : m.down;
  const applied = m.state === 'applied';
  return (
    <div style={{ padding: '16px 18px 50px', maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <div style={{ fontFamily: MONO, fontSize: 18, lineHeight: '24px', fontWeight: 500 }}>{m.version}</div>
          <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)' }}>{m.name}</div>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {m.canEdit ? <Button onClick={onEdit}>Edit</Button> : null}
          {m.canEdit && m.state === 'pending' ? <Button variant="danger-ghost" onClick={remove}>Delete</Button> : null}
          <Button onClick={dryRun} disabled={!!busy || blocked} title={blocked ? blockedWhy : 'Runs inside a transaction that is always rolled back'}>{busy === 'dry' ? 'Dry running…' : 'Dry run'}</Button>
          {applied ? (
            <Button variant="danger-ghost" onClick={() => run('rollback')} disabled={!!busy || !m.down.trim()} title={m.down.trim() ? 'Runs the down SQL' : 'No down SQL'}>{busy === 'rollback' ? 'Rolling back…' : 'Roll back'}</Button>
          ) : (
            <button onClick={() => run('apply')} disabled={!!busy || m.state === 'awaiting approval'}
              style={{ height: 26, padding: '0 12px', borderRadius: 3, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', background: blocked || m.state === 'awaiting approval' ? 'var(--bg-hover)' : 'var(--btn-primary)', color: blocked || m.state === 'awaiting approval' ? 'var(--text-muted)' : 'var(--text-inverse)', cursor: blocked ? 'not-allowed' : 'pointer' }}>
              {blocked ? 'Apply — blocked' : m.state === 'awaiting approval' ? `Awaiting approval ap-${m.approvalId}` : busy === 'apply' ? 'Applying…' : `Apply to ${conn.name}`}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 9 }}>
        {facts.map(([label, value, kind, warn]) => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 3, minWidth: 0 }}>
            <span style={{ fontFamily: kind === 'num' ? MONO : 'inherit', fontSize: kind === 'text' ? 13 : 16, lineHeight: '22px', fontWeight: 500, color: warn ? 'var(--state-running)' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
            <span style={sectionLabel}>{label}</span>
          </div>
        ))}
      </div>

      {m.state === 'failed' && m.error ? <Banner color="var(--state-error)" icon="✕" title="The last apply failed" body={m.error} /> : null}
      {m.drift ? <Banner color="var(--state-error)" icon="⚠" title="Drift: the up SQL changed after it was applied" body={`Applied ${dateTime(m.appliedAt)} by ${m.appliedBy ?? '—'}. The stored script no longer matches its checksum, so this connection may not have what the script now says. Roll back and re-apply, or write a new migration.`} /> : null}
      {list.connection.requireApproval && !applied ? <Banner color="var(--state-info)" icon="◆" title={`${conn.name} requires approval for writes`} body="Apply creates an approval request with the up SQL; an approver runs it. The state here follows the approval." /> : null}
      {a.warnings.map((w, i) => <Banner key={i} color={w.severity === 'warn' ? 'var(--state-running)' : 'var(--state-info)'} icon={w.severity === 'warn' ? '⚠' : '◆'} title={w.title} body={w.body} />)}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={sectionLabel}>Statements</span>
          <span style={{ flex: 1 }} />
          <Seg options={['Up', 'Down'] as const} value={dir} onChange={(d) => { setDir(d); setDry(null); }} />
        </div>
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', overflow: 'auto', padding: '6px 0' }}>
          {(text || (dir === 'Down' ? '-- no down SQL: this migration cannot be rolled back from Comb' : '')).split('\n').map((l, i) => {
            const bad = dry && !dry.ok && dry.statements.find((s) => !s.ok)?.line === i + 1;
            return (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '0 12px', background: bad ? 'color-mix(in oklab, var(--state-error) 12%, transparent)' : undefined }}>
                <span style={{ fontFamily: MONO, fontSize: 12, lineHeight: '19px', color: 'var(--text-muted)', width: 20, textAlign: 'right', flex: 'none', userSelect: 'none' }}>{i + 1}</span>
                <span style={{ fontFamily: MONO, fontSize: 12, lineHeight: '19px', whiteSpace: 'pre', color: l.trim().startsWith('--') ? 'var(--text-muted)' : /^(begin|commit|create|drop|alter|comment|update|insert|delete)/i.test(l) ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{l || ' '}</span>
              </div>
            );
          })}
        </div>
        {dry ? (
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
            {dry.statements.map((st, i) => (
              <div key={i} title={st.error} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 10px', minHeight: 28, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
                <span style={{ color: st.ok ? 'var(--state-success)' : 'var(--state-error)', fontSize: 12, width: 10 }}>{st.ok ? '✓' : '✕'}</span>
                <span style={{ fontFamily: MONO, fontSize: 12, width: 24, color: 'var(--text-muted)' }}>#{st.index + 1}</span>
                <span style={{ fontFamily: MONO, fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: st.ok ? 'var(--text-primary)' : 'var(--state-error)' }}>
                  {st.command}{st.ok ? (st.rowCount ? ` · ${st.rowCount} rows` : '') : ` · line ${st.line}: ${st.error}`}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>{fmtMs(st.ms)}</span>
              </div>
            ))}
            <div style={{ padding: '6px 10px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-raised)' }}>
              {dry.note} · lock_timeout 2s · {fmtMs(dry.ms)}
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={sectionLabel}>Catalog diff this produces</span>
          <span style={{ flex: 1 }} />
          {dry ? <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>from the {dir.toLowerCase()} dry run</span> : null}
        </div>
        {dry ? (
          <DiffRows lines={dry.diff} empty={dry.ok ? 'No catalog change (data-only statements).' : 'The dry run stopped at an error, so there is no diff.'} />
        ) : (
          <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 3, padding: '12px', fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1 }}>{a.noTxn ? 'This statement runs outside a transaction, so it cannot be dry-run and its diff cannot be computed in advance.' : 'Computed by running the script inside a transaction that is rolled back, and diffing tables, columns, indexes and constraints before vs. after.'}</span>
            {!a.noTxn && !blocked ? <Button size="sm" onClick={dryRun} disabled={!!busy}>Dry run</Button> : null}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={sectionLabel}>Promotion across environments</div>
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, flexWrap: 'wrap' }}>
          {m.envs.map((e) => (
            <div key={e.id} style={{ flex: '1 1 150px', display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 10px', border: '1px solid ' + (e.id === conn.id ? 'var(--border-strong)' : 'var(--border-subtle)'), borderRadius: 3, background: 'var(--bg-raised)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 2, height: 12, flex: 'none', background: IDC[e.color] ?? IDC.slate }} />
                <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: COND, fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{e.env}</span>
              </div>
              <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: stateColor(e.state), textTransform: 'uppercase' }}>{e.state}{e.drift ? ' · drift' : ''}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>{e.state === 'applied' && e.at ? dateTime(e.at) : '—'}</span>
            </div>
          ))}
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Connections in project {list.project}. Open each one to dry-run and apply in order: dev → staging → prod.</span>
      </div>
    </div>
  );
}

function Banner({ color, icon, title, body }: { color: string; icon: string; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 11px', border: '1px solid var(--border-strong)', borderLeft: `3px solid ${color}`, borderRadius: 3 }}>
      <span style={{ color, fontSize: 13 }}>{icon}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: 13, lineHeight: '18px' }}>{title}</span>
        <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{body}</span>
      </div>
    </div>
  );
}

function Editor({ init, connId, onClose, onSaved }: { init: { id?: string; version: string; name: string; up: string; down: string }; connId: string; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useApp((s) => s.toast);
  const [v, setV] = useState(init);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: v.name.trim(), up: v.up, down: v.down };
      const r = init.id ? (await api.put<{ drift: boolean }>(`/migrations/${connId}/${init.id}`, body), { id: init.id }) : await api.post<{ id: string }>(`/migrations/${connId}`, { ...body, version: v.version });
      toast(init.id ? 'Migration saved' : 'Migration created', init.id ? undefined : 'Dry run it before applying.', 'success');
      onSaved(r.id);
    } catch (e) { toastError(e, 'Could not save'); } finally { setBusy(false); }
  };
  const area: React.CSSProperties = { fontFamily: MONO, fontSize: 12, lineHeight: '19px', padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-inset)', resize: 'vertical' };
  return (
    <Modal title={init.id ? `Edit ${init.version}` : 'New migration'} onClose={onClose} width={760}
      footer={<><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No BEGIN/COMMIT: Comb wraps each run in a transaction. A down migration is required before applying to prod.</span><span className="spacer" /><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !v.name.trim() || !v.up.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 180 }}><Label>Version</Label><TextInput mono value={v.version} disabled={!!init.id} onChange={(e) => setV({ ...v, version: e.target.value })} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1 }}><Label>Name</Label><TextInput mono value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="add_orders_shipped_at_index" /></label>
        </div>
        {init.id ? <span style={{ fontSize: 12, color: 'var(--state-running)' }}>Editing the up SQL of a migration that is already applied somewhere shows as drift there.</span> : null}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><Label>Up</Label><textarea value={v.up} onChange={(e) => setV({ ...v, up: e.target.value })} rows={9} spellCheck={false} style={area} placeholder="alter table public.orders add column shipped_at timestamptz;" /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><Label>Down</Label><textarea value={v.down} onChange={(e) => setV({ ...v, down: e.target.value })} rows={5} spellCheck={false} style={area} placeholder="alter table public.orders drop column shipped_at;" /></label>
      </div>
    </Modal>
  );
}
