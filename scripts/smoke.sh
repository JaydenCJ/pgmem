#!/usr/bin/env bash
# Smoke test: build the package, then run the full
# add -> search -> link -> getGraph -> decay flow from the built entry
# against an in-process real Postgres (PGlite + pgvector).
# No network access, no Docker daemon required. Idempotent.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -d node_modules ]; then
  echo "error: node_modules missing — run 'npm install' first (smoke itself stays offline)" >&2
  exit 1
fi

echo "[smoke] building dist/ with tsc"
npm run --silent build

node scripts/smoke.mjs

echo "SMOKE OK"
