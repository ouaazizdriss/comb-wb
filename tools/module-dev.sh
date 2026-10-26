#!/bin/bash
# Runs an isolated API + web pair for one module: tools/module-dev.sh <name> <apiPort> <webPort> [migrationFilterRegex] [modules]
# Uses metadata DB comb_meta_<name>; same master key as .env so nothing else differs.
cd "$(dirname "$0")/.."
NAME=$1; API=$2; WEB=$3; FILTER=$4
eval "$(tools/module-db.sh $NAME | sed 's/^/export /')"
export PORT=$API COMB_PUBLIC_URL=http://127.0.0.1:$WEB COMB_DEMO_DSN=postgresql://postgres:postgres-dev-only@127.0.0.1:55432/shop_$NAME
[ -n "$FILTER" ] && export COMB_MIGRATION_FILTER="$FILTER"
# Optional 5th arg: comma list of modules to load (others are skipped), e.g. "monitor,topology,backup"
[ -n "$5" ] && export COMB_MODULES="$5"
npx tsx --env-file=.env server/src/index.ts &
API_URL=http://127.0.0.1:$API npm -w web run dev -- --port $WEB --strictPort &
wait
