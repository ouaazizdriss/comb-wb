import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tab, TabKind } from '../lib/store.ts';
import { useApp, useConn, toastError } from '../lib/store.ts';
import { api, downloadFrom, downloadText } from '../lib/api.ts';
import { withConfirm } from '../lib/confirm.ts';
import { ago, until, num, dateTime } from '../lib/format.ts';
import { Button, Empty, ErrorBox, Loading, MONO, COND, Seg, TextInput } from '../ui/index.tsx';

/*
 * Compliance: controls computed from live state, data subject requests planned from the catalog,
 * retention policies (reported daily, enforced only on request), residency facts.
 */

interface Control { id: string; name: string; frameworks: string; evidence: string; checkedAt: string; state: 'pass' | 'fail' | 'gap' | 'na'; fix: string | null }
interface Dsr { id: number; kind: 'access' | 'erasure' | 'rectification'; subject: string; locator: { schema: string; table: string; column: string }; dueAt: string; state: string; approvalId: number | null; result: any; createdAt: string; completedAt: string | null }
interface PlanStep { table: string; depth: number; via: string | null; action: string; columns: string[]; rows: number | null; select: string; erase: string | null; note: string }
interface Plan { subject: string; root: string; steps: PlanStep[]; unreachable: string[]; accessSql: string; erasureSql: string; text: string }
interface Policy { id: number; schema: string; table: string; column: string; keepDays: number; lastCheckedAt: string | null; over: number | null; error: string | null; lastEnforcedAt: string | null }
interface Residency { data: Array<{ host: string; connections: string[] | string }>; combServer: string; processors: Array<{ name: string; purpose: string }>; aiConfigured: boolean }

const label: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };
const box: React.CSSProperties = { border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'hidden' };
const CT = 'minmax(230px,1fr) 190px minmax(200px,1fr) 116px 110px';
const FIX_TITLE: Record<string, string> = { security: 'Security', catalog: 'Data catalog', audit: 'Audit trail', backup: 'Backups', team: 'Team & access' };
const stateText = { pass: '✓ pass', fail: '✕ fail', gap: '⚠ gap', na: '— n/a' } as const;
const stateColor = { pass: 'var(--state-success)', fail: 'var(--state-error)', gap: 'var(--state-running)', na: 'var(--text-muted)' } as const;
const kindColor = (k: string) => (k === 'erasure' ? 'var(--danger)' : k === 'access' ? 'var(--state-info)' : 'var(--state-running)');
const fmtDays = (d: number) => (d % 365 === 0 ? `${d / 365} year${d === 365 ? '' : 's'}` : d % 30 === 0 && d >= 60 ? `${d / 30} months` : `${d} day${d === 1 ? '' : 's'}`);

export default function ComplianceScreen({ tab }: { tab: Tab }) {
  void tab;
  const conn = useConn();
  const me = useApp((s) => s.me);
  const toast = useApp((s) => s.toast);
  const openTab = useApp((s) => s.openTab);
  const admin = me?.role === 'Owner' || me?.role === 'Admin';
  const controls = useQuery({ queryKey: ['compliance', 'controls', conn.id], queryFn: () => api.get<{ controls: Control[] }>(`/compliance/${conn.id}/controls`), enabled: admin });
  const [exporting, setExporting] = useState(false);

  if (!admin) return <Empty title="Compliance is for Admins" body="Controls, data subject requests and evidence packs are managed by workspace Owners and Admins." />;

  async function evidence(format: 'json' | 'csv') {
    setExporting(true);
    try {
      await downloadFrom(`/compliance/${conn.id}/evidence`, `comb-evidence-${new Date().toISOString().slice(0, 10)}.${format}`, { format });
      toast('Evidence pack downloaded', 'Control states with their evidence, the verified audit-chain head and the time it was generated. The export is in the trail.', 'success');
    } catch (e) {
      toastError(e, 'Evidence pack failed');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div style={{ padding: '18px 20px 50px', maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 20, lineHeight: '26px', fontWeight: 600 }}>Compliance</div>
            <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--text-secondary)' }}>Evidence is generated from what actually happened, not from a checklist someone ticked.</div>
          </div>
          <span style={{ flex: 1 }} />
          <button className="hov" disabled={exporting} onClick={() => void evidence('json')} style={{ height: 28, padding: '0 12px', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 13, whiteSpace: 'nowrap' }}>⤓ Evidence pack</button>
          <button className="hov" disabled={exporting} onClick={() => void evidence('csv')} style={{ height: 28, padding: '0 10px', borderRadius: 3, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>CSV</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={label}>Controls</div>
          {controls.isLoading ? <Loading label="Checking controls…" /> : controls.error ? <ErrorBox error={controls.error} onRetry={() => void controls.refetch()} /> : (
            <div style={{ ...box, overflow: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: CT, minWidth: 860, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...label }}>
                {['Control', 'Framework', 'Evidence', 'Checked', 'State'].map((h, i) => <div key={h} style={{ padding: '5px 10px', borderRight: i < 4 ? '1px solid var(--border-subtle)' : 'none' }}>{h}</div>)}
              </div>
              {controls.data!.controls.map((c, i, all) => (
                <div key={c.id} className="row-hover" style={{ display: 'grid', gridTemplateColumns: CT, minWidth: 860, height: 30, borderBottom: i < all.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                  background: c.state === 'fail' ? 'color-mix(in oklab, var(--state-error) 8%, transparent)' : c.state === 'gap' ? 'color-mix(in oklab, var(--state-running) 7%, transparent)' : undefined }}>
                  <Cell style={{ fontSize: 12 }}>{c.name}</Cell>
                  <Cell style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }} title={c.frameworks}>{c.frameworks}</Cell>
                  <Cell style={{ fontSize: 12, color: 'var(--text-secondary)' }} title={c.evidence}>{c.evidence}</Cell>
                  <Cell style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-muted)' }} title={dateTime(c.checkedAt)}>{ago(c.checkedAt)}</Cell>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px' }}>
                    <span style={{ fontFamily: MONO, fontSize: 12, whiteSpace: 'nowrap', color: stateColor[c.state] }}>{stateText[c.state]}</span>
                    <span style={{ flex: 1 }} />
                    {c.fix && c.state !== 'pass' && c.state !== 'na' ? (
                      <button onClick={() => openTab(c.fix as TabKind, FIX_TITLE[c.fix!] ?? c.fix!)} style={{ fontSize: 11, color: 'var(--state-info)', whiteSpace: 'nowrap' }}>fix</button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <Requests />

        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Retention />
          <ResidencyBox />
        </div>
      </div>
    </div>
  );
}

/**
 * Destructive compliance actions ask twice when needed: first for this module's own word (the subject or
 * the table), then — only after that — for whatever runSql's policy asks (e.g. the prod connection name).
 */
function twoStepConfirm<T>(url: string, first: { title: string; body: string }): Promise<T | undefined> {
  return withConfirm<T | undefined>((confirm) => (confirm === undefined
    ? api.post<T>(url, {})
    : withConfirm<T>((confirmRun) => api.post<T>(url, { confirm, confirmRun }))), first);
}

function Cell({ children, style, title }: { children: React.ReactNode; style?: React.CSSProperties; title?: string }) {
  return <div title={title} style={{ display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0, ...style }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span></div>;
}

function Requests() {
  const conn = useConn();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const openTab = useApp((s) => s.openTab);
  const [sel, setSel] = useState<number | null>(null);
  const [form, setForm] = useState(false);
  const [kind, setKind] = useState<'access' | 'erasure' | 'rectification'>('access');
  const [subject, setSubject] = useState('');
  const [locator, setLocator] = useState('');
  const list = useQuery({ queryKey: ['compliance', 'dsr', conn.id], queryFn: () => api.get<{ requests: Dsr[]; locators: Array<{ schema: string; table: string; column: string }> }>(`/compliance/${conn.id}/dsr`) });
  const reqs = list.data?.requests ?? [];
  const current = reqs.find((r) => r.id === sel) ?? null;
  const plan = useQuery({ queryKey: ['compliance', 'plan', conn.id, sel], queryFn: () => api.get<Plan>(`/compliance/${conn.id}/dsr/${sel}/plan`), enabled: !!current });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['compliance'] });
  const locs = list.data?.locators ?? [];
  const locKey = (l: { schema: string; table: string; column: string }) => `${l.schema}.${l.table}.${l.column}`;
  const defaultLoc = locs.find((l) => /mail/i.test(l.column)) ?? locs[0];

  const create = useMutation({
    mutationFn: () => {
      const l = locs.find((x) => locKey(x) === (locator || (defaultLoc ? locKey(defaultLoc) : '')));
      return api.post<Dsr>(`/compliance/${conn.id}/dsr`, { kind, subject: subject.trim(), locator: l });
    },
    onSuccess: (d) => { setForm(false); setSubject(''); setSel(d.id); refresh(); toast('Request recorded', 'Due in 30 days. The plan below is built from the catalog.', 'info'); },
    onError: (e) => toastError(e, 'Request not created'),
  });

  async function run(d: Dsr) {
    try {
      if (d.kind === 'erasure') {
        const url = `/compliance/${conn.id}/dsr/${d.id}/run`;
        const r = await twoStepConfirm<any>(url, { title: `Erase ${d.subject}`, body: 'Personal columns are anonymised or deleted in foreign-key order. There is no undo from Comb.' });
        if (!r) return;
        if (r.approvalId) toast(`Approval ap-${r.approvalId} requested`, `${conn.name} requires approval for writes; the erasure runs once an approver signs off.`, 'info');
        else toast('Erasure executed', `${r.statements?.length ?? 0} statements in one transaction. Recorded in the trail with the request id.`, 'success');
      } else {
        const r = await api.post<any>(`/compliance/${conn.id}/dsr/${d.id}/run`, {});
        downloadText(`dsr-${d.id}-${d.kind}.json`, JSON.stringify(r, null, 2), 'application/json');
        toast(d.kind === 'access' ? 'Access export downloaded' : 'Current data downloaded', r.masked ? 'Some values are masked for your access level; an admin on the connection exports them unmasked.' : 'Every table reachable from the subject, as JSON. The export is in the trail.', 'success');
      }
      refresh();
    } catch (e) {
      toastError(e, 'Request not run');
    }
  }

  const setState = useMutation({ mutationFn: ({ id, state }: { id: number; state: string }) => api.post(`/compliance/${conn.id}/dsr/${id}/state`, { state }), onSuccess: refresh, onError: (e) => toastError(e) });
  const open = reqs.filter((r) => r.state === 'open' || r.state === 'awaiting_approval').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={label}>Data subject requests</span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)' }}>{open} open · 30-day statutory clock</span>
        <span style={{ flex: 1 }} />
        <button className="hov" onClick={() => setForm(!form)} style={{ height: 22, padding: '0 9px', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 12, whiteSpace: 'nowrap' }}>+ New request</button>
      </div>
      {form ? (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-raised)' }}>
          {!locs.length ? (
            <span style={{ fontSize: 12, color: 'var(--state-running)' }}>No column on {conn.name} is classified PII yet. Classify personal columns in the Data catalog first — the plan is built from them.</span>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Seg options={['access', 'erasure', 'rectification'] as const} value={kind} onChange={setKind} />
            <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="the person: an email, a customer id…" style={{ flex: 1, minWidth: 220, fontFamily: MONO, fontSize: 12 }} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>matched on</span>
            <select aria-label="Identifier column" value={locator || (defaultLoc ? locKey(defaultLoc) : '')} onChange={(e) => setLocator(e.target.value)}
              style={{ height: 28, border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', fontSize: 12, fontFamily: MONO, padding: '0 4px' }}>
              {locs.map((l) => <option key={locKey(l)} value={locKey(l)}>{l.table}.{l.column}</option>)}
            </select>
            <Button variant="primary" disabled={!subject.trim() || !locs.length || create.isPending} onClick={() => create.mutate()}>Record</Button>
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Comb finds the subject's row by that column, then follows foreign keys to every table that depends on it.</span>
        </div>
      ) : null}
      <div style={box}>
        {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : reqs.length ? reqs.map((d, i) => {
          const done = d.state === 'done' || d.state === 'cancelled';
          const soon = !done && new Date(d.dueAt).getTime() - Date.now() < 7 * 86_400_000;
          return (
            <div key={d.id} className="row-hover" onClick={() => setSel(sel === d.id ? null : d.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 36, borderTop: i ? '1px solid var(--border-subtle)' : 'none', cursor: 'pointer', background: sel === d.id ? 'var(--bg-selected)' : undefined }}>
              <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', width: 92, flex: 'none', textTransform: 'uppercase', color: kindColor(d.kind) }}>{d.kind}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
                <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.subject}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>by {d.locator.table}.{d.locator.column}{d.approvalId ? ` · approval ap-${d.approvalId}` : ''}</span>
              </div>
              <span style={{ fontFamily: MONO, fontSize: 12, whiteSpace: 'nowrap', color: soon ? 'var(--state-running)' : 'var(--text-secondary)' }}>
                {done ? `${d.state === 'done' ? 'completed' : 'cancelled'} ${dateTime(d.completedAt).slice(5, 10)}` : `due ${until(d.dueAt)}`}
              </span>
              <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', width: 80, flex: 'none', textAlign: 'right', color: done ? 'var(--state-success)' : 'var(--state-running)' }}>
                {d.state === 'awaiting_approval' ? 'APPROVAL' : d.state.toUpperCase()}
              </span>
              <button onClick={(e) => { e.stopPropagation(); setSel(d.id); }} className="hov" style={{ height: 22, padding: '0 8px', border: '1px solid var(--border-strong)', borderRadius: 3, fontSize: 11, whiteSpace: 'nowrap' }}>
                {done ? 'report' : 'build plan'}
              </button>
            </div>
          );
        }) : <div style={{ padding: '18px 12px', fontSize: 12, color: 'var(--text-muted)' }}>No requests yet. Give Comb an identifier — an email, a customer id — and it walks the catalog to find every column that could hold it.</div>}
      </div>
      {current ? (
        <div style={{ border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-inset)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={label}>Reach for {current.subject} — built from the catalog, not guessed</div>
          {plan.isLoading ? <Loading label="Walking foreign keys…" /> : plan.error ? <ErrorBox error={plan.error} /> : plan.data ? (
            <>
              <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: '19px', whiteSpace: 'pre-wrap' }}>{current.kind === 'erasure' ? plan.data.text
                : `-- every table reachable from ${plan.data.root} for this subject:\n` + plan.data.steps.map((s) => `-- ${s.table.padEnd(16)} ${s.rows === null ? '?' : num(s.rows)} row${s.rows === 1 ? '' : 's'}${s.columns.length ? ' · personal: ' + s.columns.join(', ') : ''}`).join('\n')
                  + (plan.data.unreachable.length ? `\n\n-- not reachable by foreign key: ${plan.data.unreachable.join(', ')} (review by hand)` : '')
                  + '\n-- output: one JSON document, rows per table, machine-readable.'}</pre>
              {current.result && current.state === 'done' ? (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Result: {current.result.statements
                  ? current.result.statements.map((s: any) => `${s.table} ${String(s.command).toLowerCase()} ${s.rows ?? 0}`).join(' · ')
                  : `${num(current.result.total)} rows exported`}</div>
              ) : null}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {current.state === 'open' ? (
                  current.kind === 'erasure'
                    ? <Button size="sm" variant="danger" disabled={!plan.data.erasureSql} onClick={() => void run(current)}>Erase…</Button>
                    : <Button size="sm" variant="primary" onClick={() => void run(current)}>{current.kind === 'access' ? 'Run & download export' : 'Download current data'}</Button>
                ) : null}
                <Button size="sm" onClick={() => openTab('query', `dsr-${current.id}`, { sql: current.kind === 'erasure' ? plan.data!.erasureSql : plan.data!.accessSql }, { unique: false })}>Open statements in a query tab</Button>
                <span style={{ flex: 1 }} />
                {current.state === 'open' || current.state === 'awaiting_approval' ? (
                  <>
                    {current.kind === 'rectification' || current.state === 'awaiting_approval' ? <Button size="sm" variant="ghost" onClick={() => setState.mutate({ id: current.id, state: 'done' })}>Mark done</Button> : null}
                    <Button size="sm" variant="ghost" onClick={() => setState.mutate({ id: current.id, state: 'cancelled' })}>Cancel request</Button>
                  </>
                ) : null}
              </div>
              {current.kind === 'erasure' && current.state === 'open' ? (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Erasure asks you to type the subject, then runs through the connection's policy: on approval-required connections it becomes an approval request.</span>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Retention() {
  const conn = useConn();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState('');
  const [days, setDays] = useState('90');
  const list = useQuery({ queryKey: ['compliance', 'retention', conn.id], queryFn: () => api.get<Policy[]>(`/compliance/${conn.id}/retention`) });
  const cat = useQuery({ queryKey: ['catalog', conn.id], queryFn: () => api.get<{ columns: Array<{ schema: string; table: string; column: string; type: string }> }>(`/catalog/${conn.id}`), enabled: adding });
  const tsCols = (cat.data?.columns ?? []).filter((c) => /^(timestamp|date)/.test(c.type));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['compliance'] });
  const add = useMutation({
    mutationFn: () => { const [schema, table, column] = target.split('.'); return api.post(`/compliance/${conn.id}/retention`, { schema, table, column, keepDays: Number(days) }); },
    onSuccess: () => { setAdding(false); refresh(); toast('Retention policy saved', 'Comb counts rows over the limit every day. It deletes nothing until you press Enforce.', 'info'); },
    onError: (e) => toastError(e, 'Policy not saved'),
  });
  async function enforce(p: Policy) {
    try {
      const r = await twoStepConfirm<any>(`/compliance/${conn.id}/retention/${p.id}/enforce`,
        { title: `Delete rows from ${p.table}`, body: `Rows whose ${p.column} is older than ${fmtDays(p.keepDays)} are deleted. There is no undo from Comb.` });
      if (!r) return;
      toast(r.approvalId ? `Approval ap-${r.approvalId} requested` : `${num(r.deleted)} rows deleted`, r.approvalId ? 'The delete runs once approved.' : 'Recorded in the audit trail.', 'success');
      refresh();
    } catch (e) {
      toastError(e, 'Not enforced');
    }
  }
  const del = useMutation({ mutationFn: (id: number) => api.del(`/compliance/${conn.id}/retention/${id}`), onSuccess: refresh, onError: (e) => toastError(e) });

  return (
    <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={label}>Retention policies</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setAdding(!adding)} className="hov-text" style={{ fontSize: 11, color: 'var(--state-info)' }}>{adding ? 'cancel' : '+ add'}</button>
      </div>
      {adding ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select aria-label="Table and timestamp column" value={target} onChange={(e) => setTarget(e.target.value)}
            style={{ height: 26, flex: 1, minWidth: 160, border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', fontSize: 12, fontFamily: MONO }}>
            <option value="">— table.timestamp column —</option>
            {tsCols.map((c) => <option key={`${c.schema}.${c.table}.${c.column}`} value={`${c.schema}.${c.table}.${c.column}`}>{c.table}.{c.column}</option>)}
          </select>
          <TextInput mono aria-label="Days to keep" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} style={{ width: 64, height: 26 }} />
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>days</span>
          <Button size="sm" variant="primary" disabled={!target || !Number(days) || add.isPending} onClick={() => add.mutate()}>Save</Button>
        </div>
      ) : null}
      <div style={box}>
        {(list.data ?? []).map((p, i) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 34, borderTop: i ? '1px solid var(--border-subtle)' : 'none' }}>
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.table}</span>
              <span style={{ fontSize: 11, color: p.error ? 'var(--state-error)' : 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.error ? p.error : p.lastCheckedAt ? `${num(p.over)} rows over · checked ${ago(p.lastCheckedAt)}` : 'not checked yet'}
              </span>
            </div>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{fmtDays(p.keepDays)}</span>
            <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', whiteSpace: 'nowrap', width: 74, textAlign: 'right', color: p.over ? 'var(--state-running)' : 'var(--state-success)' }}>
              {p.over ? 'REPORTED' : 'WITHIN'}
            </span>
            {p.over ? <button onClick={() => void enforce(p)} style={{ fontSize: 11, color: 'var(--danger)', whiteSpace: 'nowrap' }}>enforce</button> : null}
            <button aria-label={`Remove policy on ${p.table}`} onClick={() => del.mutate(p.id)} className="hov-text" style={{ fontSize: 11, color: 'var(--text-muted)' }}>✕</button>
          </div>
        ))}
        {list.data && !list.data.length ? <div style={{ padding: '14px 12px', fontSize: 12, color: 'var(--text-muted)' }}>No policies. Add one per table that holds personal data; Comb reports daily and deletes only when you enforce.</div> : null}
      </div>
    </div>
  );
}

function ResidencyBox() {
  const conn = useConn();
  const { data } = useQuery({ queryKey: ['compliance', 'residency', conn.id], queryFn: () => api.get<Residency>(`/compliance/${conn.id}/residency`) });
  const rows: Array<[string, string]> = data ? [
    ...data.data.map((d, i) => [i ? '' : 'Data', `${d.host} · ${Array.isArray(d.connections) ? d.connections.join(', ') : d.connections}`] as [string, string]),
    ['Comb server', data.combServer],
    ['Sub-processors', data.processors.length ? data.processors.map((p) => `${p.name} — ${p.purpose}`).join('; ') : 'none'],
  ] : [];
  return (
    <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={label}>Residency &amp; processors</div>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, padding: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {rows.map(([l, v], i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', width: 96, flex: 'none' }}>{l}</span>
            <span style={{ fontFamily: MONO, fontSize: 12, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{v}</span>
          </div>
        ))}
        <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)', paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
          {data?.aiConfigured
            ? 'The AI panel is on, which adds Anthropic as a processor: what you send from the AI panel leaves your infrastructure.'
            : 'Turning on the AI panel adds one processor. That is the only case where data leaves your infrastructure, and it is off until you set a key.'}
        </div>
      </div>
    </div>
  );
}
