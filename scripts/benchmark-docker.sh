#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

docker compose up -d --build postgres mqtt migrate world-api observation-ingest projection-worker world-mcp-server
docker compose run --rm world-api node dist/scripts/seed.js
BENCH_MAX_OBJECTS="${BENCH_MAX_OBJECTS:-1000000}" node dist/tests/performance/postgis-benchmark.js
node dist/tests/integration/http-acceptance.js
LOAD_DURATION_SECONDS="${LOAD_DURATION_SECONDS:-1}" node dist/tests/performance/http-load.js
MQTT_BENCH_MESSAGES="${MQTT_BENCH_MESSAGES:-1000}" node dist/tests/performance/mqtt-benchmark.js

printf '%s\n' "Docker benchmark and HTTP acceptance completed; results are under output/."
