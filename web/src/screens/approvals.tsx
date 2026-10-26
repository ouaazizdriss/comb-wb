import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tab } from '../lib/store.ts';
import { useApp, toastError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { ago, ms as fmtMs } from '../lib/format.ts';
import { Button, ErrorBox, IDC, Loading, MONO, COND } from '../ui/index.tsx';
import { kindColor } from './audit.tsx';

/*
 * Approvals (mockup: isApprovalsTab). The server enforces the policy (approver ≠ author, Admin/Owner
 * or connection admin, race-safe claim); this screen only shows what the server says is possible.
 */

type Filter = 'waiting-on-me' | 'open' | 'mine' | 'decided';
const FILTERS: Array<[Filter, string]> = [['waiting-on-me', 'Waiting on me'], ['open', 'All open'], ['mine', 'Mine'], ['decided', 'Decided']];

interface Conn { id: string; name: string; env: string; color: string }
interface ListRow { id: number; kind: string; title: string; state: string; estRows: number | null; createdAt: string; author: string; decidedBy: string | null; connection: Conn; mine: boolean }
interface ListData { rows: ListRow[]; pending: number; medianDecisionSeconds: number | null }
interface Detail {
  id: number; kind: string; title: string; sql: string; state: string; estRows: number | null; createdAt: string; decidedAt: string | null; appliedAt: string | null;
  result: any; author: { email: string; name: string } | null; decidedBy: { email: string; name: string } | null; connection: Conn;
  estimates: Array<{ index: number; command: string; target: string | null; rows: number | null; error: string | null }>;
  warnings: Array<{ title: string; body: string }>;
  dryRun: { ok: boolean; ms: number; steps: Array<{ index: number; command: string; target: string | null; ok: boolean; rows?: number | null; ms: number; locks?: string[]; error?: string }> } | null;
  dryRunAt: string | null;
  comments: Array<{ id: number; body: string; at: string; who: string; name: string; isAuthor: boolean }>;
  can: { approve: boolean; reject: boolean; withdraw: boolean; dryRun: boolean };
  isAuthor: boolean;
}

const labelStyle: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };
const stateColor = (s: string) => (s === 'pending' ? 'var(--state-running)' : s === 'approved' || s === 'applied' ? 'var(--state-success)' : s === 'withdrawn' ? 'var(--text-muted)' : 'var(--state-error)');
const short = (e: string | null | undefined) => (e ? e.split('@')[0] : '—');

export default function ApprovalsScreen({ tab }: { tab: Tab }) {
  const updateTab = useApp((s) => s.updateTab);
  const filter: Filter = tab.params?.filter ?? 'waiting-on-me';
  const list = useQuery({ queryKey: ['approvals', filter], queryFn: () => api.get<ListData>(`/approvals?filter=${filter}`), refetchInterval: 30_000 });
  const rows = list.data?.rows ?? [];
  const sel: number | undefined = rows.find((r) => r.id === tab.params?.sel)?.id ?? rows[0]?.id;
  const median = list.data?.medianDecisionSeconds;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflowX: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden', height: 22, flex: 'none' }}>
          {FILTERS.map(([f, label], i) => (
            <button key={f} onClick={() => updateTab(tab.id, { params: { filter: f, sel: null } })}
              style={{ ...labelStyle, padding: '0 9px', whiteSpace: 'nowrap', background: filter === f ? 'var(--bg-selected)' : 'transparent', color: filter === f ? 'var(--text-primary)' : 'var(--text-muted)',
                borderRight: i < FILTERS.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>{label}</button>
          ))}
        </div>
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: 'none' }}>
          {list.data ? `${list.data.pending} pending${median !== null && median !== undefined ? ' · median decision ' + (median < 60 ? 'under 1 min' : Math.round(median / 60) + ' min') : ''}` : '…'}
        </span>
        <span style={{ flex: 1, minWidth: 8 }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', flex: 'none' }}>Policy: writes on prod need one approver who did not author them</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ width: 330, flex: 'none', borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', overflow: 'auto' }}>
          {list.isLoading ? <Loading /> : list.isError ? <ErrorBox error={list.error} onRetry={() => list.refetch()} /> : null}
          {rows.map((a) => (
            <div key={a.id} className="row-hover" onClick={() => updateTab(tab.id, { params: { sel: a.id } })}
              style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)', background: sel === a.id ? 'var(--bg-selected)' : undefined }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: kindColor(a.kind), whiteSpace: 'nowrap' }}>{a.kind}</span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>ap-{a.id}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', whiteSpace: 'nowrap', color: stateColor(a.state) }}>{a.state.toUpperCase()}</span>
              </div>
              <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.title}{a.estRows !== null ? ` · ${a.estRows.toLocaleString('en-US')} row${a.estRows === 1 ? '' : 's'}` : ''}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 2, height: 11, flex: 'none', background: IDC[a.connection.color] ?? IDC.slate }} />
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.connection.name} · {a.mine ? 'you' : short(a.author)} → {a.state === 'pending' ? (a.mine ? 'an approver' : 'you') : short(a.decidedBy)} · {ago(a.createdAt)}
                </span>
              </div>
            </div>
          ))}
          {list.data && !rows.length ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, lineHeight: '17px' }}>Nothing here. An empty queue is the goal, not a bug.</div>
          ) : null}
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {sel ? <ApprovalDetail key={sel} id={sel} /> : list.data ? (
            <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 40 }}>
              <div style={{ textAlign: 'center', maxWidth: 320 }}>
                <div style={{ fontSize: 24, lineHeight: '30px', fontWeight: 600, marginBottom: 6 }}>Queue is clear.</div>
                <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)' }}>No statement is waiting on a human. Writes on connections without the approval requirement never come through here.</div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ApprovalDetail({ id }: { id: number }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const d = useQuery({ queryKey: ['approval', id], queryFn: () => api.get<Detail>(`/approvals/${id}`) });

  const act = async (what: 'approve' | 'reject' | 'withdraw' | 'dry-run' | 'comments', body: object = {}) => {
    setBusy(what);
    try {
      const r = await api.post<Detail>(`/approvals/${id}/${what}`, body);
      qc.setQueryData(['approval', id], r);
      qc.invalidateQueries({ queryKey: ['approvals'] });
      if (what === 'approve') {
        if (r.state === 'applied') toast(`Approved and applied ap-${id}`, `Ran on ${r.connection.name} as you · ${r.result?.ms ?? 0} ms. The author has been notified.`, 'success');
        else toast(`Approved ap-${id}, but it failed`, String(r.result?.error ?? 'See the result below.'), 'error');
      }
      if (what === 'reject') toast(`Rejected ap-${id}`, note ? 'Your note was added to the thread.' : 'Add a note so they know what to change.', 'error');
      if (what === 'withdraw') toast(`Withdrew ap-${id}`, 'Nothing ran.', 'info');
      if (what === 'dry-run') toast(r.dryRun?.ok ? 'Dry run passed' : 'Dry run found a problem', 'Everything was rolled back.', r.dryRun?.ok ? 'success' : 'error');
      if (what === 'comments' || what === 'reject') setNote('');
    } catch (e) {
      toastError(e, what === 'approve' ? 'Not approved' : 'Action failed');
      d.refetch();
    } finally {
      setBusy(null);
    }
  };

  if (d.isLoading) return <Loading />;
  if (d.isError) return <ErrorBox error={d.error} onRetry={() => d.refetch()} />;
  const a = d.data!;
  const kc = kindColor(a.kind);
  const pending = a.state === 'pending';
  const facts: Array<[string, string, boolean]> = [
    ['Estimated rows', a.estRows === null ? (a.estimates.some((e) => e.error) ? 'error' : 'n/a') : a.estRows.toLocaleString('en-US'), true],
    ['Connection', `${a.connection.name} · ${a.connection.env}`, false],
    ['Author', a.author?.email ?? '—', false],
    ['Requested', ago(a.createdAt), false],
  ];
  const lockModes = [...new Set((a.dryRun?.steps ?? []).flatMap((s) => s.locks ?? []))];
  if (lockModes.length) facts.push(['Locks taken', lockModes.map((m) => m.replace(/Lock$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()).join(', '), false]);

  return (
    <div style={{ padding: '16px 18px 50px', maxWidth: 800, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', padding: '1px 5px', border: '1px solid ' + kc, color: kc, whiteSpace: 'nowrap' }}>{a.kind}</span>
            <span style={{ fontFamily: MONO, fontSize: 18, lineHeight: '24px', fontWeight: 500 }}>ap-{a.id}</span>
            <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: stateColor(a.state) }}>{a.state.toUpperCase()}</span>
          </div>
          <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--text-secondary)' }}>
            {a.title} · requested by {a.isAuthor ? 'you' : short(a.author?.email)} on {a.connection.name}
            {a.decidedBy ? ` · ${a.state === 'withdrawn' ? 'withdrawn' : 'decided by ' + short(a.decidedBy.email)} ${ago(a.decidedAt)}` : ''}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 6 }}>
          {a.can.withdraw ? <Button size="md" onClick={() => act('withdraw')} disabled={!!busy}>Withdraw</Button> : null}
          {a.can.reject ? <Button variant="danger-ghost" onClick={() => act('reject', note.trim() ? { note: note.trim() } : {})} disabled={!!busy}>Reject</Button> : null}
          {pending && a.can.approve ? (
            <Button variant="primary" onClick={() => act('approve')} disabled={!!busy}>{busy === 'approve' ? 'Applying…' : 'Approve'}</Button>
          ) : (
            <span title={pending && a.isAuthor ? 'You authored this request; someone else has to approve it.' : undefined}
              style={{ height: 26, padding: '0 13px', borderRadius: 3, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', background: 'var(--bg-hover)', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center' }}>
              {pending ? (a.isAuthor ? 'Awaiting another approver' : 'Approve') : a.state.charAt(0).toUpperCase() + a.state.slice(1)}
            </span>
          )}
        </div>
      </div>

      <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', padding: '10px 12px' }}>
        <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: '19px', whiteSpace: 'pre-wrap' }}>{a.sql}</pre>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 9 }}>
        {facts.map(([label, value, num]) => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 3, minWidth: 0 }}>
            <span style={{ fontFamily: num ? MONO : 'inherit', fontSize: num ? 18 : 13, lineHeight: '22px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value}>{value}</span>
            <span style={labelStyle}>{label}</span>
          </div>
        ))}
      </div>

      {a.warnings.map((w, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 11px', border: '1px solid var(--border-strong)', borderLeft: '3px solid var(--state-running)', borderRadius: 3 }}>
          <span style={{ color: 'var(--state-running)', fontSize: 13 }}>⚠</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 13, lineHeight: '18px' }}>{w.title}</span>
            <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)' }}>{w.body}</span>
          </div>
        </div>
      ))}

      {a.result ? (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 11px', border: '1px solid var(--border-strong)', borderLeft: '3px solid ' + (a.result.ok ? 'var(--state-success)' : 'var(--state-error)'), borderRadius: 3 }}>
          <span style={{ color: a.result.ok ? 'var(--state-success)' : 'var(--state-error)', fontSize: 13 }}>{a.result.ok ? '✓' : '✕'}</span>
          <div style={{ fontSize: 12, lineHeight: '17px' }}>
            {a.result.ok
              ? `Applied by ${a.decidedBy?.email ?? '—'} ${ago(a.appliedAt)} · ${(a.result.statements ?? []).map((s: any) => `${s.command} ${s.rowCount ?? 0}`).join(', ')} · ${a.result.ms} ms`
              : `Apply failed: ${a.result.error}`}
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={labelStyle}>Dry run against a branch of the schema</span>
          <span style={{ flex: 1 }} />
          {a.can.dryRun ? <Button size="sm" onClick={() => act('dry-run')} disabled={!!busy}>{busy === 'dry-run' ? 'Running…' : a.dryRun ? 'Run again' : 'Run dry run'}</Button> : null}
        </div>
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
          {(dryLines(a)).map((l, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '7px 10px', borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
              <span style={{ width: 12, flex: 'none', fontSize: 11, color: l[0] === '✓' ? 'var(--state-success)' : l[0] === '✕' ? 'var(--state-error)' : l[0] === '⚠' ? 'var(--state-running)' : 'var(--text-muted)' }}>{l[0]}</span>
              <span style={{ fontSize: 12, lineHeight: '17px', flex: 1, minWidth: 0 }}>{l[1]}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={labelStyle}>Thread</div>
        {[...a.comments].reverse().map((t) => (
          <div key={t.id} style={{ display: 'flex', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border-subtle)' }}>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)', width: 88, flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis' }} title={t.who}>{short(t.who)}{t.isAuthor ? ' ·a' : ''}</span>
            <span style={{ fontSize: 13, lineHeight: '19px', flex: 1, minWidth: 0, whiteSpace: 'pre-wrap' }}>{t.body}</span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{ago(t.at)}</span>
          </div>
        ))}
        {!a.comments.length ? <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>No notes yet.</div> : null}
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={pending ? 'Add a note before deciding…' : 'Add a note…'} maxLength={4000}
            onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) act('comments', { body: note.trim() }); }}
            style={{ flex: 1, height: 28, padding: '0 10px', background: 'var(--bg-raised)', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 13 }} />
          <Button onClick={() => note.trim() && act('comments', { body: note.trim() })} disabled={!note.trim() || !!busy} style={{ height: 28 }}>Comment</Button>
        </div>
      </div>
    </div>
  );
}

function dryLines(a: Detail): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const est = a.estimates.filter((e) => e.rows !== null || e.error);
  if (est.some((e) => e.error)) out.push(['✕', 'Planning failed: ' + est.find((e) => e.error)!.error]);
  else if (est.length) out.push(['✓', `Planned against the live catalog: ${est.map((e) => `${e.command} ${e.target ?? ''} ≈ ${e.rows!.toLocaleString('en-US')} rows`).join(' · ')}.`]);
  if (!a.dryRun) {
    out.push(['·', a.can.dryRun ? 'Not run yet. The dry run executes the statements in a transaction that is always rolled back (lock_timeout 2 s).' : 'Not run yet. An approver can run it; it always rolls back.']);
    return out;
  }
  for (const s of a.dryRun.steps) {
    if (s.ok) out.push(['✓', `${s.command}${s.target ? ' ' + s.target : ''}: ${s.rows ?? 0} row${s.rows === 1 ? '' : 's'} affected in ${fmtMs(s.ms)}${s.locks?.length ? ' · locks ' + s.locks.join(', ') : ''}.`]);
    else out.push(['✕', `${s.command ?? 'Statement'}${s.target ? ' ' + s.target : ''}: ${s.error}`]);
  }
  out.push([a.dryRun.ok ? '✓' : '⚠', `Rolled back after ${fmtMs(a.dryRun.ms)}${a.dryRunAt ? ' · ' + ago(a.dryRunAt) : ''}. Sequence values used by nextval() are not returned.`]);
  return out;
}
