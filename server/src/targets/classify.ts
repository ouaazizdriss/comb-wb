import { loadModule, parseSync, normalizeSync } from 'libpg-query';
import type { StatementKind } from '@comb/shared';

/*
 * SQL classification with the real Postgres parser (libpg-query). Every policy decision
 * (read-only, approvals, typed confirmations, audit kind) is made from this result,
 * never from the browser and never from regexes.
 */

export interface Classified {
  /** Exact statement text as sent to the server (one statement). */
  sql: string;
  /** Offset of the statement in the original input, for error positions. */
  start: number;
  /** Upper-case command, e.g. SELECT, UPDATE, DROP TABLE, GRANT. */
  command: string;
  kind: StatementKind;
  /** Relations referenced, schema-qualified when written that way. */
  targets: string[];
  /** Set for DROP, TRUNCATE, and UPDATE/DELETE without WHERE. */
  destructive: { kind: string; target: string } | null;
  /** Must run outside a transaction block (VACUUM, CREATE INDEX CONCURRENTLY, ...). */
  noTxn: boolean;
  /** Non-null when the statement may never run through Comb. */
  blocked: string | null;
}

export class SqlSyntaxError extends Error {
  constructor(message: string, public position: number | undefined) {
    super(message);
  }
}

let ready: Promise<void> | null = null;
export function initClassifier(): Promise<void> {
  ready ??= loadModule();
  return ready;
}

const MODIFYING = new Set(['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt']);
const PRIVILEGE = new Set([
  'GrantStmt', 'GrantRoleStmt', 'CreateRoleStmt', 'AlterRoleStmt', 'AlterRoleSetStmt', 'DropRoleStmt',
  'AlterDefaultPrivilegesStmt', 'ReassignOwnedStmt', 'DropOwnedStmt', 'AlterSystemStmt', 'CreateUserMappingStmt',
  'AlterUserMappingStmt', 'DropUserMappingStmt', 'AlterOwnerStmt',
]);
// Session-level parameters a user may change for the duration of their own request.
const SAFE_SET = new Set(['search_path', 'timezone', 'datestyle', 'intervalstyle', 'client_min_messages', 'extra_float_digits', 'bytea_output', 'work_mem', 'enable_seqscan', 'enable_indexscan', 'enable_hashjoin', 'enable_mergejoin', 'enable_nestloop', 'jit']);

// Functions that change session state or reach the server's filesystem/network. set_config is
// allowed only for SAFE_SET parameters given as a constant; the rest are refused outright.
const BLOCKED_FUNCS = new Set([
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'pg_ls_logdir', 'pg_ls_waldir', 'pg_ls_tmpdir',
  'pg_ls_archive_statusdir', 'lo_import', 'lo_export', 'pg_file_write', 'pg_file_rename', 'pg_file_unlink',
  'pg_reload_conf', 'pg_rotate_logfile', 'pg_promote', 'pg_terminate_backend', 'pg_cancel_backend',
  'dblink', 'dblink_exec', 'dblink_connect', 'dblink_connect_u', 'dblink_send_query', 'dblink_open',
  'pg_create_restore_point', 'pg_switch_wal', 'pg_start_backup', 'pg_backup_start', 'pg_stop_backup', 'pg_backup_stop',
  // These execute SQL passed as a string, which the classifier cannot see.
  'query_to_xml', 'query_to_xmlschema', 'query_to_xml_and_xmlschema', 'cursor_to_xml', 'cursor_to_xmlschema',
  'table_to_xml', 'table_to_xmlschema', 'table_to_xml_and_xmlschema', 'schema_to_xml', 'schema_to_xmlschema',
  'schema_to_xml_and_xmlschema', 'database_to_xml', 'database_to_xmlschema', 'database_to_xml_and_xmlschema',
  'ts_stat', 'ts_rewrite',
]);
const BLOCKED_PREFIXES = ['dblink', 'pg_ls_', 'pg_read_', 'pg_file_', 'lo_import', 'lo_export'];

function funcName(fc: any): string {
  const parts = (fc?.funcname ?? []).map((n: any) => n?.String?.sval ?? '');
  return String(parts[parts.length - 1] ?? '').toLowerCase();
}

/** Returns a reason when the tree calls a function Comb refuses, else null. */
function blockedFunction(node: unknown): string | null {
  let reason: string | null = null;
  walk(node, (k, v) => {
    if (reason || k !== 'FuncCall') return;
    const name = funcName(v);
    if (BLOCKED_FUNCS.has(name) || BLOCKED_PREFIXES.some((p) => name.startsWith(p))) {
      reason = `${name}() is not allowed through Comb`;
    } else if (name === 'set_config') {
      const arg = v?.args?.[0]?.A_Const?.sval?.sval;
      if (typeof arg !== 'string' || !SAFE_SET.has(arg.toLowerCase())) {
        reason = `set_config(${typeof arg === 'string' ? arg : '…'}) is not allowed through Comb`;
      }
    }
  });
  return reason;
}

function walk(node: unknown, visit: (key: string, value: any) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      visit(k, v);
      walk(v, visit);
    }
  }
}

function rangeVars(node: unknown): string[] {
  const out: string[] = [];
  const add = (v: any) => {
    if (v && typeof v === 'object' && typeof v.relname === 'string') out.push((v.schemaname ? v.schemaname + '.' : '') + v.relname);
  };
  add(node);
  walk(node, (_k, v) => add(v));
  return [...new Set(out)];
}

function hasModifyingSubstatement(node: unknown): boolean {
  let found = false;
  walk(node, (k) => {
    if (MODIFYING.has(k)) found = true;
  });
  return found;
}

function nameList(items: any[] | undefined): string {
  if (!items?.length) return '';
  return items.map((i: any) => i?.String?.sval ?? '').filter(Boolean).join('.');
}

function words(type: string): string {
  // "CreateTableAsStmt" -> "CREATE TABLE AS"
  return type.replace(/Stmt$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
}

function classifyNode(type: string, n: any): Omit<Classified, 'sql' | 'start'> {
  const base = { targets: rangeVars(n), destructive: null as Classified['destructive'], noTxn: false, blocked: null as string | null };
  switch (type) {
    case 'SelectStmt': {
      if (n.intoClause) return { ...base, command: 'SELECT INTO', kind: 'ddl' };
      if (hasModifyingSubstatement(n)) return { ...base, command: 'SELECT', kind: 'write' };
      if (n.lockingClause) return { ...base, command: 'SELECT FOR UPDATE', kind: 'write' };
      return { ...base, command: n.valuesLists ? 'VALUES' : 'SELECT', kind: 'read' };
    }
    case 'InsertStmt': return { ...base, command: 'INSERT', kind: 'write' };
    case 'MergeStmt': return { ...base, command: 'MERGE', kind: 'write' };
    case 'UpdateStmt': {
      const t = base.targets[0] ?? '';
      return { ...base, command: 'UPDATE', kind: 'write', destructive: n.whereClause ? null : { kind: 'UPDATE', target: t } };
    }
    case 'DeleteStmt': {
      const t = base.targets[0] ?? '';
      return { ...base, command: 'DELETE', kind: 'write', destructive: n.whereClause ? null : { kind: 'DELETE', target: t } };
    }
    case 'TruncateStmt': return { ...base, command: 'TRUNCATE', kind: 'write', destructive: { kind: 'TRUNCATE', target: base.targets.join(', ') } };
    case 'ExplainStmt': {
      const off = (arg: any) => arg?.Boolean?.boolval === false || ['false', 'off', '0', 'no'].includes(String(arg?.String?.sval ?? arg?.Integer?.ival ?? '').toLowerCase());
      const analyze = (n.options ?? []).some((o: any) => o?.DefElem?.defname === 'analyze' && !off(o.DefElem.arg));
      const inner = n.query ? Object.entries(n.query)[0] : null;
      if (analyze && inner) {
        const c = classifyNode(inner[0], inner[1]);
        return { ...c, command: 'EXPLAIN ANALYZE', blocked: c.blocked };
      }
      return { ...base, command: 'EXPLAIN', kind: 'read' };
    }
    case 'VariableShowStmt': return { ...base, command: 'SHOW', kind: 'read' };
    case 'VariableSetStmt': {
      const name = String(n.name ?? '').toLowerCase();
      const blocked = name && SAFE_SET.has(name) ? null : `SET ${name || 'ALL'} is not allowed through Comb`;
      return { ...base, command: n.kind === 'VAR_RESET' || n.kind === 'VAR_RESET_ALL' ? 'RESET' : 'SET', kind: 'session', blocked };
    }
    case 'TransactionStmt':
      return { ...base, command: String(n.kind ?? 'TRANSACTION').replace(/^TRANS_STMT_/, ''), kind: 'transaction',
        blocked: 'Comb wraps each run in its own transaction; BEGIN/COMMIT/ROLLBACK are not accepted' };
    case 'CopyStmt': {
      if (n.filename || n.is_program) return { ...base, command: 'COPY', kind: 'write', blocked: 'COPY to or from server files or programs is not allowed' };
      return { ...base, command: 'COPY', kind: n.is_from ? 'write' : 'read', blocked: 'COPY over the wire is not supported here; use Export' };
    }
    case 'DoStmt': return { ...base, command: 'DO', kind: 'write' };
    case 'CallStmt': return { ...base, command: 'CALL', kind: 'write' };
    case 'LockStmt': return { ...base, command: 'LOCK', kind: 'write' };
    case 'RefreshMatViewStmt': return { ...base, command: 'REFRESH MATERIALIZED VIEW', kind: 'write', noTxn: !!n.concurrent };
    case 'NotifyStmt': return { ...base, command: 'NOTIFY', kind: 'write' };
    case 'VacuumStmt': return { ...base, command: n.is_vacuumcmd ? 'VACUUM' : 'ANALYZE', kind: 'utility', noTxn: !!n.is_vacuumcmd };
    case 'CheckPointStmt': return { ...base, command: 'CHECKPOINT', kind: 'utility' };
    case 'ReindexStmt': {
      const conc = (n.params ?? []).some((p: any) => p?.DefElem?.defname === 'concurrently');
      return { ...base, command: 'REINDEX', kind: 'utility', noTxn: conc };
    }
    case 'ClusterStmt': return { ...base, command: 'CLUSTER', kind: 'utility' };
    case 'IndexStmt': return { ...base, command: 'CREATE INDEX', kind: 'ddl', noTxn: !!n.concurrent };
    case 'DropStmt': {
      const objType = String(n.removeType ?? '').replace(/^OBJECT_/, '').replace(/_/g, ' ');
      const target = (n.objects ?? []).map((o: any) => nameList(o?.List?.items) || o?.String?.sval || '').filter(Boolean).join(', ');
      return { ...base, command: 'DROP ' + objType, kind: 'ddl', destructive: { kind: 'DROP', target }, noTxn: !!n.concurrent,
        targets: target ? target.split(', ') : base.targets };
    }
    case 'DropRoleStmt': {
      const target = (n.roles ?? []).map((r: any) => r?.RoleSpec?.rolename).filter(Boolean).join(', ');
      return { ...base, command: 'DROP ROLE', kind: 'privilege', destructive: { kind: 'DROP ROLE', target }, targets: [target] };
    }
    case 'CreatedbStmt':
    case 'DropdbStmt':
    case 'AlterDatabaseStmt':
    case 'AlterDatabaseSetStmt':
    case 'CreateTableSpaceStmt':
    case 'DropTableSpaceStmt':
      return { ...base, command: words(type), kind: 'ddl', blocked: 'Database and tablespace administration is outside Comb' };
    case 'LoadStmt':
      return { ...base, command: 'LOAD', kind: 'utility', blocked: 'LOAD is not allowed' };
    case 'DiscardStmt':
    case 'ListenStmt':
    case 'UnlistenStmt':
    case 'PrepareStmt':
    case 'ExecuteStmt':
    case 'DeallocateStmt':
    case 'DeclareCursorStmt':
    case 'FetchStmt':
    case 'ClosePortalStmt':
      return { ...base, command: words(type), kind: 'session', blocked: `${words(type)} is not supported in Comb's stateless sessions` };
  }
  if (PRIVILEGE.has(type)) return { ...base, command: words(type), kind: 'privilege' };
  if (/^(Create|Alter|Drop|Rename|Comment|Define|Rule|View|Composite|CreateEnum|AlterEnum|SecLabel|ImportForeignSchema)/.test(type)) {
    return { ...base, command: words(type), kind: 'ddl' };
  }
  return { ...base, command: words(type), kind: 'unknown' };
}

export function classify(input: string): Classified[] {
  let tree: any;
  try {
    tree = parseSync(input);
  } catch (e: any) {
    const pos = typeof e?.sqlDetails?.cursorPosition === 'number' ? e.sqlDetails.cursorPosition + 1 : undefined;
    throw new SqlSyntaxError(String(e?.message ?? e), pos);
  }
  const out: Classified[] = [];
  for (const s of tree.stmts ?? []) {
    const start = s.stmt_location ?? 0;
    const len = s.stmt_len ?? input.length - start;
    const raw = input.slice(start, start + (len || input.length - start));
    const lead = raw.length - raw.trimStart().length;
    const sql = raw.trim();
    const [type, node] = Object.entries(s.stmt ?? {})[0] ?? ['Unknown', {}];
    const c = classifyNode(type, node);
    c.blocked ??= blockedFunction(node);
    out.push({ sql, start: start + lead, ...c });
  }
  return out.filter((c) => c.sql.length > 0);
}

/** Replaces literal values with $1, $2, ... for history redaction. Falls back to a marker. */
export function redactLiterals(sql: string): string {
  try {
    // Parse first: on some scanner errors (an unterminated string) normalizeSync returns the error message,
    // which quotes the partial literal, instead of throwing.
    parseSync(sql);
    return normalizeSync(sql);
  } catch {
    return '-- statement redacted (could not be normalised)';
  }
}
