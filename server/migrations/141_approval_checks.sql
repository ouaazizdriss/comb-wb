-- Review facts for approval requests (gov module): plan estimates and the last dry run.
-- One row per approval, overwritten on refresh; the decision trail itself lives in audit_log.
create table approval_checks (
  approval_id  bigint primary key references approvals(id) on delete cascade,
  estimates    jsonb,                     -- [{ index, command, target, rows, error }]
  warnings     jsonb,                     -- [{ title, body }]
  estimated_at timestamptz,
  dry_run      jsonb,                     -- { ok, steps: [...], ms }
  dry_run_at   timestamptz,
  dry_run_by   uuid references users(id) on delete set null
);
