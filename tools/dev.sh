#!/bin/bash
# Starts API (PORT, default 8080) and web (WEB_PORT, default 5173) for local development.
cd "$(dirname "$0")/.."
PORT=${PORT:-8080} npx tsx --env-file=.env server/src/index.ts &
API_URL=http://127.0.0.1:${PORT:-8080} npm -w web run dev -- --port ${WEB_PORT:-5173} --strictPort &
wait
