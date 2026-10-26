/*
 * Response shapes of the ops module (monitoring, topology, backups).
 * Type-only: imported with `import type` from server and web, so it adds no runtime code.
 */

export type MonitorRange = '15m' | '1h' | '6h' | '24h';
export const MONITOR_RANGES: readonly MonitorRange[] = ['15m', '1h', '6h', '24h'];

export interface MonitorLive {
  at: string;
  connTotal: number;
  connActive: number;
  connIdleTxn: number;
  connWaiting: number;
  maxConn: number;
  /** Transactions per second since the previous stored sample; null until two samples exist. */
  tps: number | null;
  /** Interval cache hit ratio (0..1) since the previous sample; falls back to the cumulative ratio. */
  cacheHit: number | null;
  cacheHitCumulative: number | null;
  isReplica: boolean;
  replLag: number | null;
  replicas: number;
  longestXactS: number | null;
  longestXactPid: number | null;
  longestXactState: string | null;
  longestIdleTxnS: number | null;
  deadlocksTotal: number;
  dbSize: number;
  sharedBuffers: string;
}

export interface MonitorBucket {
  at: string;
  connTotal: number | null;
  maxConn: number | null;
  tps: number | null;
  cacheHit: number | null;
  replLag: number | null;
  longestXact: number | null;
  deadlocks: number | null;
}

export interface MonitorOverview {
  header: { host: string; port: number; db: string; version: string; startedAt: string | null; role: 'primary' | 'replica' };
  live: MonitorLive | null;
  liveError: string | null;
  range: MonitorRange;
  buckets: MonitorBucket[];
  totals: { deadlocks: number; peakConn: number | null; peakConnAt: string | null; avgTps: number | null; prevAvgTps: number | null; samples: number };
  sampler: { lastAt: string | null; lastOk: boolean | null; lastError: string | null };
  rules: MonitorRules;
}

export interface MonitorRules {
  replicaLagSeconds: number;
  replicaLagMinutes: number;
  connectionsPct: number;
  idleTxnSeconds: number;
  cacheHitPct: number;
  longXactSeconds: number;
  deadlockQuietMinutes: number;
}

export interface MonitorAlert {
  id: number;
  rule: string;
  severity: 'warn' | 'crit';
  title: string;
  body: string;
  openedAt: string;
  lastSeenAt: string;
  ackedAt: string | null;
  ackedBy: string | null;
}

export interface SlowStatement {
  queryid: string;
  query: string;
  calls: number;
  meanMs: number;
  totalMs: number;
  rows: number;
  share: number;
}

export type SlowStatementsResponse =
  | { available: true; rows: SlowStatement[]; totalMs: number }
  | { available: false; reason: string; hint: string };

export interface LockRow {
  pid: number;
  depth: number;
  role: 'blocker' | 'waiter';
  blocks: number;
  blockedBy: number[];
  user: string | null;
  app: string | null;
  state: string | null;
  query: string;
  lock: string | null;
  waitS: number | null;
  xactS: number | null;
  /** Comb's own internal sessions: never terminable. */
  internal: boolean;
}

export interface HealthRow {
  schema: string;
  name: string;
  totalBytes: number;
  liveTup: number;
  deadTup: number;
  bloat: number | null;
  method: 'pgstattuple_approx' | 'statistics' | 'dead tuples' | null;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
}

export interface HealthResponse {
  rows: HealthRow[];
  pgstattuple: boolean;
}

export interface ReplicaInfo {
  name: string;
  addr: string | null;
  state: string | null;
  syncState: string | null;
  writeLag: number | null;
  flushLag: number | null;
  replayLag: number | null;
  sentBehind: number | null;
  replayBehind: number | null;
  slot: string | null;
  lagSeries: number[];
}

export interface SlotInfo {
  name: string;
  type: string;
  active: boolean;
  retainedBytes: number | null;
  walStatus: string | null;
  warn: boolean;
}

export interface PatroniMember {
  name: string;
  role: string;
  state: string;
  host: string | null;
  port: number | null;
  timeline: number | null;
  lag: number | string | null;
}

export interface FailoverEvent {
  at: string | null;
  kind: string;
  text: string;
  timeline: number | null;
}

export interface TopologyResponse {
  role: 'primary' | 'replica';
  host: string;
  port: number;
  version: string;
  startedAt: string | null;
  timeline: number | null;
  region: string | null;
  replicas: ReplicaInfo[];
  slots: SlotInfo[];
  upstream: null | { status: string; host: string | null; port: number | null; slot: string | null; lastMsgAt: string | null; replayLag: number | null };
  archiver: null | { mode: string; lastArchivedAt: string | null; lastFailedAt: string | null; failed: number; archived: number };
  self: { connTotal: number | null; maxConn: number | null; dbSize: number | null; walRate: number | null; load: number[] };
  patroni: { configured: boolean; url: string | null; members: PatroniMember[]; error: string | null; scope: string | null };
  history: { source: 'patroni' | 'timeline'; events: FailoverEvent[]; note: string };
  settings: { patroniUrl: string | null; hasPatroniAuth: boolean; allowHosts: string[]; region: string | null };
}

export interface BackupRow {
  id: number;
  backend: 'logical' | 'pgbackrest';
  kind: string;
  status: 'running' | 'ok' | 'error' | 'expired';
  startedAt: string;
  finishedAt: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  sha256: string | null;
  destination: string | null;
  tableCount: number | null;
  verified: boolean | null;
  verifiedAt: string | null;
  verifyNote: string | null;
  error: string | null;
  createdBy: string;
}

export interface OpsTask {
  id: number;
  kind: 'backup' | 'restore_scratch' | 'restore_inplace' | 'verify';
  status: 'queued' | 'running' | 'ok' | 'error';
  backupId: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  createdBy: string;
}

export interface BackupOverview {
  backend: 'logical' | 'pgbackrest';
  capabilities: {
    pgDump: string | null;
    pgRestore: string | null;
    pgbackrest: string | null;
    stanza: string | null;
    createdb: boolean | null;
    dir: string;
    notes: string[];
  };
  backups: BackupRow[];
  tasks: OpsTask[];
  window: null | { start: string; end: string; continuous: boolean };
  points: Array<{ id: number; at: string }>;
  retention: { keepLast: number };
  pgbackrest: null | { status: string; archiveMin: string | null; archiveMax: string | null };
}
