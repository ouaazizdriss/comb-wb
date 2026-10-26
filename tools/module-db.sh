#!/bin/bash
# Creates (or recreates with --reset) an isolated metadata database comb_meta_<name> for parallel development.
set -e
NAME=$1; [ -z "$NAME" ] && { echo "usage: tools/module-db.sh <name> [--reset]"; exit 1; }
DB=comb_meta_$NAME
cd "$(dirname "$0")/.."
PSQL="docker compose -p comb exec -T db psql -U postgres -v ON_ERROR_STOP=1"
if [ "$2" == "--reset" ]; then $PSQL -c "drop database if exists $DB with (force)" >/dev/null; fi
$PSQL -tAc "select 1 from pg_database where datname='$DB'" | grep -q 1 || {
  $PSQL -c "create database $DB owner comb_owner" >/dev/null
  $PSQL -c "revoke all on database $DB from public; grant connect on database $DB to comb_app" >/dev/null
}
echo "COMB_DATABASE_URL=postgres://comb_app:comb-app-dev-only@127.0.0.1:55432/$DB"
echo "COMB_MIGRATION_DATABASE_URL=postgres://comb_owner:comb-owner-dev-only@127.0.0.1:55432/$DB"
