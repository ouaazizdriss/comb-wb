-- Row-level before/after images for audited writes (gov module).
-- Rows are captured by the pre-write hook (server/src/modules/audit.ts → captureDiff) and
-- referenced from the audit event as detail.diffId, so the hash chain covers the link.
-- Row values are envelope-encrypted (data_enc, AAD = 'audit-diff:<id>'): the metadata DB never
-- holds target row values in clear. Like audit_log, the table is append-only for comb_app.
create table audit_row_diffs (
  id            uuid primary key,
  at            timestamptz not null default now(),
  connection_id uuid,
  relation      text not null,            -- schema.table as resolved in the catalog
  op            text not null check (op in ('UPDATE','DELETE','INSERT')),
  pk            text[] not null,          -- primary-key column names, in key order
  total         bigint not null,          -- rows the statement matched
  captured      integer not null,         -- rows whose images are stored (capped)
  fields        jsonb not null,           -- [{ name, type, tableID, columnID }] for masking + SQL generation
  data_enc      bytea not null            -- encrypted { before: object[], after: object[] }
);
create index audit_row_diffs_at_idx on audit_row_diffs (at desc);
revoke update, delete, truncate on audit_row_diffs from comb_app;
