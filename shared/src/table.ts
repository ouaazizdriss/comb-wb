import { z } from 'zod';
import type { TypeFamily } from './index.ts';

/*
 * Contract between the Table tab (web/src/screens/table.tsx) and its server module
 * (server/src/modules/table.ts). Edits travel as structured data, never as SQL text:
 * the server re-validates every column against the catalog and builds the statements itself.
 */

export const TABLE_SUBS = ['Data', 'Structure', 'Constraints', 'Indexes', 'Triggers', 'DDL'] as const;
export type TableSub = (typeof TABLE_SUBS)[number];
export const PAGE_SIZE = 100;

export type RelKind = 'table' | 'partitioned' | 'view' | 'matview' | 'foreign';

export interface TableColumn {
  name: string;
  attnum: number;
  type: string;
  family: TypeFamily;
  notNull: boolean;
  default: string | null;
  comment: string | null;
  pk: boolean;
  fk: string | null;
  identity: '' | 'a' | 'd';
  generated: boolean;
  /** Not null, no default, not identity/generated: an INSERT must supply it. */
  required: boolean;
}

export interface TableMeta {
  schema: string;
  table: string;
  kind: RelKind;
  comment: string | null;
  columns: TableColumn[];
  pk: string[];
  estimate: number | null;
  /** True when the estimate came from a capped count (the table was never analyzed). */
  exactCount: boolean;
  rls: { enabled: boolean; forced: boolean; policies: number };
  /** Whether the grid can stage edits for this caller, and why not when it cannot. */
  editable: boolean;
  readOnlyReason: string | null;
  needsApproval: boolean;
  level: string;
}

/** A primary-key value or a cell value in its Postgres text form. null is SQL NULL. */
export const cellValue = z.union([z.string().max(1_000_000), z.number(), z.boolean(), z.null()]);
const ident = z.string().min(1).max(63);
const pkMap = z.record(ident, cellValue);

export const rowsQuery = z.object({
  schema: ident,
  table: ident,
  sort: ident.optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  filter: z.string().max(200).optional(),
  /** Keyset cursor: primary-key values of the last row of the previous page. */
  after: z.array(cellValue).max(32).optional(),
  /** Offset paging, used when there is no primary key or the sort is not the key. */
  offset: z.number().int().min(0).max(10_000_000).optional(),
});
export type RowsQuery = z.infer<typeof rowsQuery>;

export interface RowsResult {
  columns: Array<{ name: string; type: string; family: TypeFamily }>;
  rows: unknown[][];
  /** Primary-key values per row (same order as meta.pk), or null without a key. */
  keys: unknown[][] | null;
  hasMore: boolean;
  paging: 'keyset' | 'offset';
  ms: number;
}

export const editBody = z.object({
  schema: ident,
  table: ident,
  confirm: z.string().max(200).optional(),
  updates: z.array(z.object({ pk: pkMap, set: pkMap })).max(200).default([]),
  deletes: z.array(z.object({ pk: pkMap })).max(500).default([]),
  inserts: z.array(z.object({ values: pkMap })).max(200).default([]),
});
export type EditBody = z.infer<typeof editBody>;

export interface EditPreview {
  statements: Array<{ kind: 'UPDATE' | 'DELETE' | 'INSERT'; sql: string }>;
}

export interface EditResult {
  approvalId?: number;
  statements: Array<{ command: string; rowCount: number | null; ms: number }>;
  ms: number;
}

export interface ConstraintRow { name: string; kind: string; def: string; deferrable: boolean; validated: boolean }
export interface IndexRow { name: string; def: string; unique: boolean; primary: boolean; valid: boolean; size: number; scans: number | null; tupRead: number | null; constraint: boolean }
export interface TriggerRow { name: string; def: string; enabled: string; func: string; timing: string; events: string }
export interface PolicyRow { name: string; cmd: string; permissive: boolean; roles: string; using: string | null; check: string | null }
