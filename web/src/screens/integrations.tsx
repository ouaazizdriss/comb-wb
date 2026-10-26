import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DATADOG_SITES, INTEGRATION_KINDS, INTEGRATION_META,
  type CombEventName, type IntegrationKind, type IntegrationSummary, type IntegrationsOverview,
} from '@comb/shared/src/platform.ts';
import type { Tab } from '../lib/store.ts';
import { useApp, toastError } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { withConfirm } from '../lib/confirm.ts';
import { ago, ms } from '../lib/format.ts';
import { Button, Callout, COND, Empty, ErrorBox, Loading, MONO, Modal, Seg, TextInput, Toggle } from '../ui/index.tsx';

const SECTION: React.CSSProperties = { fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };

function stateOf(i: IntegrationSummary): { label: string; color: string } {
  switch (i.state) {
    case 'ok': return { label: 'CONNECTED', color: 'var(--state-success)' };
    case 'failing': return { label: 'FAILING', color: 'var(--state-error)' };
    case 'new': return { label: 'NO DELIVERIES YET', color: 'var(--text-secondary)' };
    default: return { label: 'OFF', color: 'var(--text-muted)' };
  }
}

function lastText(i: IntegrationSummary): string {
  const d = i.lastDelivery;
  if (!d) return i.enabled ? 'never delivered' : '—';
  const when = ago(d.at);
  if (d.status === 'ok') return `${when} · ${d.statusCode ?? 'sent'}${d.ms !== null ? ' · ' + ms(d.ms) : ''}`;
  return `${when} · ${d.status}${d.statusCode ? ' ' + d.statusCode : ''}`;
}

/** Integrations: cards, event subscription matrix, private-host allowlist. */
export default function IntegrationsScreen({ tab }: { tab: Tab }) {
  void tab;
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api.get<IntegrationsOverview>('/integrations'), refetchInterval: 15_000 });
  const [editing, setEditing] = useState<IntegrationSummary | 'new' | null>(null);
  const [history, setHistory] = useState<IntegrationSummary | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['integrations'] });

  const toggle = useMutation({
    mutationFn: (i: IntegrationSummary) => api.patch(`/integrations/${i.id}`, { enabled: !i.enabled }),
    onSuccess: refresh,
    onError: (e) => toastError(e, 'Could not change the integration'),
  });
  const sub = useMutation({
    mutationFn: (v: { integrationId: string; event: CombEventName; on: boolean }) => api.put('/integrations/subscriptions', v),
    onMutate: async (v) => {
      qc.setQueryData<IntegrationsOverview>(['integrations'], (old) => {
        if (!old) return old;
        const cur = new Set(old.subscriptions[v.integrationId] ?? []);
        if (v.on) cur.add(v.event); else cur.delete(v.event);
        return { ...old, subscriptions: { ...old.subscriptions, [v.integrationId]: [...cur] } };
      });
    },
    onSettled: refresh,
    onError: (e) => toastError(e, 'Could not change the subscription'),
  });

  async function test(i: IntegrationSummary) {
    setTesting(i.id);
    try {
      const r = await api.post<{ ok: boolean; statusCode: number | null; ms: number | null; error: string | null }>(`/integrations/${i.id}/test`);
      if (r.ok) toast('Test event sent to ' + i.name, `Delivered${r.statusCode ? ' · HTTP ' + r.statusCode : ''} in ${ms(r.ms)}. Check ${i.target}.`, 'success');
      else toast('Test to ' + i.name + ' failed', r.error ?? 'Unknown error', 'error');
    } catch (e) {
      toastError(e, 'Test failed');
    } finally {
      setTesting(null);
      void refresh();
    }
  }

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data!;
  const list = data.integrations;
  const canEdit = data.canEdit;
  const evT = `minmax(180px,1fr) repeat(${Math.max(1, list.length)}, 104px)`;
  const minW = 200 + Math.max(1, list.length) * 104;

  return (
    <div className="screen">
      <div style={{ padding: '18px 20px 50px', maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 280 }}>
            <div style={{ fontSize: 20, lineHeight: '26px', fontWeight: 600 }}>Integrations</div>
            <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--text-secondary)' }}>Comb pushes events out. It does not let anything reach in and run SQL.</div>
          </div>
          {canEdit ? <Button variant="primary" onClick={() => setEditing('new')}>+ Add integration</Button> : null}
        </div>

        {!canEdit ? <Callout kind="info" title="Read-only">Only Admins can add, change or test integrations.</Callout> : null}

        {list.length === 0 ? (
          <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 3 }}>
            <Empty title="No integrations yet" body="Slack, Microsoft Teams, signed webhooks, PagerDuty, email over SMTP and Datadog logs. Each one gets only the events you subscribe it to below." action={canEdit ? <Button onClick={() => setEditing('new')}>+ Add integration</Button> : undefined} />
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(268px,1fr))', gap: 10 }}>
            {list.map((i) => {
              const st = stateOf(i);
              const meta = INTEGRATION_META[i.kind];
              return (
                <div key={i.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '11px 12px', border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-raised)', opacity: i.enabled ? 1 : 0.66 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ width: 26, height: 26, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: 3, border: '1px solid var(--border-strong)', fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', color: i.enabled ? 'var(--text-primary)' : 'var(--text-muted)', background: i.enabled ? 'var(--bg-base)' : 'transparent' }}>{meta.mark}</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, lineHeight: '18px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={meta.label}>{i.name}</span>
                      <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.target}>{i.target}</span>
                    </div>
                    <span className="spacer" />
                    <Toggle on={i.enabled} disabled={!canEdit || toggle.isPending} onChange={() => toggle.mutate(i)} title={canEdit ? (i.enabled ? 'Turn off' : 'Turn on') : 'Admins only'} />
                  </div>
                  <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)' }}>
                    {meta.desc}
                    {i.lastDelivery && i.lastDelivery.status !== 'ok' && i.lastDelivery.error ? (
                      <div style={{ color: 'var(--state-error)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }} title={i.lastDelivery.error}>{i.lastDelivery.error}</div>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: st.color, whiteSpace: 'nowrap' }}>{st.label}</span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastText(i)}</span>
                    <span className="spacer" />
                    <button onClick={() => setHistory(i)} style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} className="hov-text">log</button>
                    {canEdit ? <button onClick={() => setEditing(i)} style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} className="hov-text">edit</button> : null}
                    {canEdit ? <button onClick={() => test(i)} disabled={testing === i.id} style={{ fontSize: 11, color: 'var(--state-info)', whiteSpace: 'nowrap' }}>{testing === i.id ? 'sending…' : 'test'}</button> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={SECTION}>Event subscriptions</div>
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3, overflow: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: evT, minWidth: minW, background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-strong)', ...SECTION }}>
              <div style={{ padding: '5px 10px', borderRight: '1px solid var(--border-subtle)' }}>Event</div>
              {list.length ? list.map((i) => (
                <div key={i.id} title={i.name} style={{ padding: '5px 8px', borderRight: '1px solid var(--border-subtle)', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</div>
              )) : <div style={{ padding: '5px 8px', textAlign: 'center' }}>—</div>}
            </div>
            {data.events.map((ev, r) => (
              <div key={ev} className="row-hover" style={{ display: 'grid', gridTemplateColumns: evT, minWidth: minW, height: 30, borderTop: r ? '1px solid var(--border-subtle)' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px', borderRight: '1px solid var(--border-subtle)', fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev}</div>
                {list.length ? list.map((i) => {
                  const on = (data.subscriptions[i.id] ?? []).includes(ev);
                  return (
                    <button
                      key={i.id}
                      disabled={!canEdit}
                      aria-pressed={on}
                      title={`${on ? 'Unsubscribe' : 'Subscribe'} ${i.name} ${on ? 'from' : 'to'} ${ev}`}
                      onClick={() => sub.mutate({ integrationId: i.id, event: ev, on: !on })}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: '1px solid var(--border-subtle)', cursor: canEdit ? 'pointer' : 'default' }}
                    >
                      <span style={{ fontSize: on ? 9 : 12, color: on ? (i.enabled ? 'var(--state-success)' : 'var(--text-secondary)') : 'var(--text-muted)' }}>{on ? '●' : '·'}</span>
                    </button>
                  );
                }) : <div />}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>
            Payloads carry ids and counts, never row values — a Slack channel is not a place for customer data. Values are strings, numbers or booleans only, and strings are cut at 200 characters. Failed deliveries retry 4 times with exponential backoff.
          </div>
        </div>

        {canEdit ? <Allowlist hosts={data.allowPrivateHosts} onSaved={refresh} /> : null}
      </div>
      {editing ? <EditModal integ={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} /> : null}
      {history ? <HistoryModal integ={history} onClose={() => setHistory(null)} /> : null}
    </div>
  );
}

function Allowlist({ hosts, onSaved }: { hosts: string[]; onSaved: () => void }) {
  const [text, setText] = useState(hosts.join(', '));
  const [dirty, setDirty] = useState(false);
  const toast = useApp((s) => s.toast);
  const save = useMutation({
    mutationFn: () => api.put('/integrations/allowlist', { hosts: text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) }),
    onSuccess: () => { setDirty(false); toast('Allowlist saved'); onSaved(); },
    onError: (e) => toastError(e, 'Could not save the allowlist'),
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={SECTION}>Private hosts allowed</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <TextInput mono value={text} placeholder="none — e.g. hooks.acme.internal, 10.2.0.15" onChange={(e) => { setText(e.target.value); setDirty(true); }} style={{ flex: 1 }} />
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save</Button>
      </div>
      <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-muted)' }}>
        Outbound calls to loopback, private, link-local and cloud-metadata addresses are refused, including after DNS resolution and redirects. List a host here only if a receiver really lives on your internal network.
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="label">{label}</span>
      {children}
      {hint ? <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--text-muted)' }}>{hint}</span> : null}
    </label>
  );
}

function randomSecret(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return 'whsec_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function EditModal({ integ, onClose, onSaved }: { integ: IntegrationSummary | null; onClose: () => void; onSaved: () => void }) {
  const toast = useApp((s) => s.toast);
  const [kind, setKind] = useState<IntegrationKind>(integ?.kind ?? 'slack');
  const c = integ?.config ?? {};
  const [name, setName] = useState(integ?.name ?? '');
  const [url, setUrl] = useState('');
  const [signing, setSigning] = useState('');
  const [key, setKey] = useState('');
  const [site, setSite] = useState<string>(String(c.site ?? 'datadoghq.com'));
  const [smtp, setSmtp] = useState({ host: String(c.host ?? ''), port: String(c.port ?? '587'), tls: String(c.tls ?? 'starttls'), user: String(c.user ?? ''), from: String(c.from ?? ''), to: Array.isArray(c.to) ? c.to.join(', ') : '' });
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isNew = !integ;
  const keep = integ?.last4 ? `•••• ${integ.last4} — leave blank to keep` : '';

  function body(): Record<string, unknown> {
    const b: Record<string, unknown> = { name: name.trim() };
    if (isNew) b.kind = kind;
    if (kind === 'slack' || kind === 'teams' || kind === 'webhook') { if (url || isNew) b.url = url.trim(); }
    if (kind === 'webhook' && (signing || isNew)) b.signingSecret = signing;
    if (kind === 'pagerduty' && (key || isNew)) b.routingKey = key.trim();
    if (kind === 'datadog') { if (key || isNew) b.apiKey = key.trim(); b.site = site; }
    if (kind === 'email') {
      b.smtp = { host: smtp.host.trim(), port: Number(smtp.port), tls: smtp.tls, user: smtp.user.trim(), from: smtp.from.trim(), to: smtp.to.split(/[\s,;]+/).filter(Boolean) };
      if (password) b.password = password;
    }
    return b;
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      if (isNew) await api.post('/integrations', body());
      else await api.patch(`/integrations/${integ!.id}`, body());
      toast(isNew ? 'Integration added' : 'Integration saved', 'Secrets are stored encrypted and never shown again.');
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      const r = await withConfirm((confirm) => api.del(`/integrations/${integ!.id}`, confirm ? { confirm } : {}), { body: 'Its subscriptions and delivery history are removed too. Scheduled jobs that deliver to it will start failing.' });
      if (r) { toast('Integration removed'); onSaved(); }
    } catch (e) {
      toastError(e, 'Could not remove');
    }
  }

  return (
    <Modal
      title={isNew ? 'Add integration' : `Edit ${integ!.name}`}
      onClose={onClose}
      width={520}
      footer={<>
        {!isNew ? <Button variant="danger-ghost" onClick={remove}>Remove</Button> : null}
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !name.trim()} onClick={submit}>{busy ? 'Saving…' : isNew ? 'Add' : 'Save'}</Button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {isNew ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Seg options={INTEGRATION_KINDS} value={kind} onChange={setKind} labels={{ slack: 'Slack', webhook: 'Webhook', teams: 'Teams', pagerduty: 'PagerDuty', email: 'Email', datadog: 'Datadog' }} />
          </div>
        ) : null}
        <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--text-secondary)' }}>{INTEGRATION_META[kind].desc}</div>
        <Field label="Name"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={INTEGRATION_META[kind].label + ' — #ops-alerts'} /></Field>
        {kind === 'slack' || kind === 'teams' || kind === 'webhook' ? (
          <Field label={INTEGRATION_META[kind].secretLabel} hint={kind === 'webhook' ? 'http(s). Internal hosts need the allowlist below.' : 'https only. The URL is a secret: anyone holding it can post to your channel.'}>
            <TextInput mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder={keep || (kind === 'slack' ? 'https://hooks.slack.com/services/…' : kind === 'teams' ? 'https://….webhook.office.com/…' : 'https://hooks.acme.internal/comb')} autoComplete="off" />
          </Field>
        ) : null}
        {kind === 'webhook' ? (
          <Field label="Signing secret" hint={<>Requests carry <span style={{ fontFamily: MONO }}>X-Comb-Timestamp</span> and <span style={{ fontFamily: MONO }}>X-Comb-Signature: sha256=HMAC(secret, timestamp + "." + body)</span>. Reject anything older than 5 minutes. Copy the secret now: Comb never shows it again.</>}>
            <div style={{ display: 'flex', gap: 6 }}>
              <TextInput mono value={signing} onChange={(e) => setSigning(e.target.value)} placeholder={isNew ? 'at least 16 characters' : 'leave blank to keep'} style={{ flex: 1 }} autoComplete="off" />
              <Button onClick={() => setSigning(randomSecret())}>Generate</Button>
            </div>
          </Field>
        ) : null}
        {kind === 'pagerduty' || kind === 'datadog' ? (
          <Field label={INTEGRATION_META[kind].secretLabel}>
            <TextInput mono value={key} onChange={(e) => setKey(e.target.value)} placeholder={keep || (kind === 'pagerduty' ? '32-character integration key' : 'Datadog API key')} autoComplete="off" />
          </Field>
        ) : null}
        {kind === 'datadog' ? (
          <Field label="Site">
            <select value={site} onChange={(e) => setSite(e.target.value)} style={{ height: 28, border: '1px solid var(--border-subtle)', borderRadius: 3, background: 'var(--bg-base)', fontFamily: MONO, fontSize: 12, padding: '0 6px' }}>
              {DATADOG_SITES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        ) : null}
        {kind === 'email' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 8 }}>
              <Field label="SMTP host"><TextInput mono value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.acme.com" /></Field>
              <Field label="Port"><TextInput mono value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value.replace(/\D/g, '') })} /></Field>
            </div>
            <Field label="Encryption" hint={smtp.tls === 'none' ? 'Plaintext: Comb refuses to send a username and password this way.' : smtp.tls === 'tls' ? 'Implicit TLS, usually port 465.' : 'STARTTLS, usually port 587. The server must offer it.'}>
              <Seg options={['starttls', 'tls', 'none'] as const} value={smtp.tls as 'starttls' | 'tls' | 'none'} onChange={(v) => setSmtp({ ...smtp, tls: v })} labels={{ starttls: 'STARTTLS', tls: 'TLS', none: 'None' }} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Field label="User"><TextInput mono value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} placeholder="optional" autoComplete="off" /></Field>
              <Field label="Password"><TextInput mono type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={integ?.hasSecret ? 'leave blank to keep' : 'optional'} autoComplete="new-password" /></Field>
            </div>
            <Field label="From"><TextInput mono value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} placeholder="comb@acme.com" /></Field>
            <Field label="To" hint="Comma-separated, up to 20."><TextInput mono value={smtp.to} onChange={(e) => setSmtp({ ...smtp, to: e.target.value })} placeholder="dba@acme.com, oncall@acme.com" /></Field>
          </>
        ) : null}
        {kind === 'slack' || kind === 'teams' || kind === 'pagerduty' || kind === 'datadog' ? (
          <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--text-muted)' }}>Scheduled job results reach this integration as a summary only. CSV attachments go to email and webhook integrations.</div>
        ) : null}
        {err ? <Callout kind="error" title="Not saved">{err}</Callout> : null}
      </div>
    </Modal>
  );
}

function HistoryModal({ integ, onClose }: { integ: IntegrationSummary; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['integration-deliveries', integ.id],
    queryFn: () => api.get<Array<{ id: string; at: string; event: string; attempt: number; status: string; statusCode: number | null; ms: number | null; error: string | null; test: boolean }>>(`/integrations/${integ.id}/deliveries`),
    retry: false,
  });
  const color = (s: string) => (s === 'ok' ? 'var(--state-success)' : s === 'retrying' ? 'var(--state-running)' : 'var(--state-error)');
  return (
    <Modal title={`Deliveries · ${integ.name}`} onClose={onClose} width={680} footer={<><span className="spacer" /><Button onClick={onClose}>Close</Button></>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? (
        <Empty title="Nothing delivered yet" body="Send a test, or subscribe this integration to an event." />
      ) : (
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 3 }}>
          {q.data!.map((d, i) => (
            <div key={d.id} style={{ display: 'grid', gridTemplateColumns: '92px 150px 74px 1fr', gap: 8, alignItems: 'center', padding: '5px 10px', borderTop: i ? '1px solid var(--border-subtle)' : 'none', fontSize: 12 }}>
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>{ago(d.at)}</span>
              <span style={{ fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.event}{d.attempt > 1 ? ` #${d.attempt}` : ''}</span>
              <span style={{ fontFamily: COND, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: color(d.status), textTransform: 'uppercase' }}>{d.status}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.error ?? ''}>
                {[d.statusCode ? 'HTTP ' + d.statusCode : null, d.ms !== null ? ms(d.ms) : null, d.error].filter(Boolean).join(' · ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
