/*
 * Integrations + Deployment contract shared by server and web.
 */

export const INTEGRATION_KINDS = ['slack', 'webhook', 'teams', 'pagerduty', 'email', 'datadog'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** Every event the core bus can emit (mirrors CombEvent in server/src/core/events.ts). */
export const COMB_EVENTS = [
  'job.failed',
  'job.succeeded',
  'query.blocked',
  'approval.requested',
  'approval.decided',
  'migration.applied',
  'monitor.critical',
  'backup.completed',
  'dq.failed',
  'security.alert',
] as const;
export type CombEventName = (typeof COMB_EVENTS)[number];

export const INTEGRATION_META: Record<IntegrationKind, { label: string; mark: string; desc: string; secretLabel: string }> = {
  slack: { label: 'Slack', mark: 'SL', desc: 'Job failures, blocked queries and approval requests as messages you can act on.', secretLabel: 'Incoming webhook URL' },
  webhook: { label: 'Webhook', mark: 'WH', desc: 'Signed JSON for anything the others do not cover.', secretLabel: 'Endpoint URL' },
  teams: { label: 'Microsoft Teams', mark: 'MT', desc: 'The same messages as Slack, for teams that live in Teams.', secretLabel: 'Incoming webhook URL' },
  pagerduty: { label: 'PagerDuty', mark: 'PD', desc: 'Only what you subscribe here pages. Warnings stay in Comb.', secretLabel: 'Events API v2 routing key' },
  email: { label: 'Email', mark: 'EM', desc: 'SMTP delivery for scheduled job results and alerts.', secretLabel: 'SMTP password' },
  datadog: { label: 'Datadog', mark: 'DD', desc: 'Events as structured logs, next to the rest of your telemetry.', secretLabel: 'API key' },
};

export const DATADOG_SITES = ['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ddog-gov.com'] as const;

export interface DeliveryInfo {
  at: string;
  status: 'ok' | 'failed' | 'retrying' | 'refused';
  statusCode: number | null;
  ms: number | null;
  error: string | null;
  event: string;
  test: boolean;
  attempt: number;
}

export interface IntegrationSummary {
  id: string;
  kind: IntegrationKind;
  name: string;
  enabled: boolean;
  /** Masked target, e.g. "hooks.slack.com/…/•••• 4f81". Never a secret. */
  target: string;
  config: Record<string, string | number | boolean | string[]>;
  hasSecret: boolean;
  last4: string | null;
  hasSigningSecret?: boolean;
  state: 'ok' | 'failing' | 'off' | 'new';
  lastDelivery: DeliveryInfo | null;
  delivered24h: number;
  failed24h: number;
}

export interface IntegrationsOverview {
  integrations: IntegrationSummary[];
  events: CombEventName[];
  subscriptions: Record<string, CombEventName[]>;
  allowPrivateHosts: string[];
  canEdit: boolean;
  emailAvailable: boolean;
}

// ── Deployment ────────────────────────────────────────────────

export const FLAG_DEFS = [
  { key: 'ai.panel', hint: 'Schema-aware SQL drafting.', default: true },
  { key: 'erd.inferred_edges', hint: 'Guess relationships where no FK exists.', default: true },
  { key: 'grid.inline_edit', hint: 'Staged edits on primary-keyed tables.', default: true },
  { key: 'approvals.required_on_prod', hint: 'Enforce the second pair of eyes.', default: true },
  { key: 'experimental.explain_visualiser', hint: 'Plan trees as a flame graph. Rough.', default: false },
] as const;
export type FlagKey = (typeof FLAG_DEFS)[number]['key'];

/** Workspace members, for information only (Comb has no seat limit). Service identities are counted apart. */
export interface MemberCounts {
  active: number;
  invited: number;
  service: number;
}

export interface ServiceRow {
  name: string;
  role: string;
  version: string;
  replicas: string;
  /** 0..1, null when there is nothing meaningful to show. */
  load: number | null;
  loadLabel: string;
  state: 'healthy' | 'degraded' | 'down' | 'idle' | 'off';
  facts: Array<[string, string]>;
}

export interface ReleaseRow {
  version: string;
  date: string;
  notes: string;
  state: 'current' | 'earlier' | 'available';
}
