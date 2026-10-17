#!/usr/bin/env bash
# One benchmark run on a fresh database with a freshly built API.
# Usage: bash scripts/bench.sh <label>   (results saved to perf/results-<label>.md)
set -e
label="${1:?usage: bench.sh <label>}"
docker compose down -v
docker compose up --build -d db api
until curl -sf localhost:3000/health > /dev/null; do sleep 1; done
npm run loadtest
cp perf/results.md "perf/results-$label.md"
# Authoritative correctness check straight from the database (0 rows = consistent)
docker compose exec -T db psql -U app -d metering < scripts/check-invariants.sql
