#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

mkdir -p output/acceptance output/benchmarks
npm run check
npm test
npm run benchmark

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' "Docker is unavailable: source/unit/scenario/in-process benchmark passed; G1 and DB-backed G2-G10 remain environment-unverified."
  exit 0
fi

docker compose config --quiet
docker compose up -d --build
docker compose run --rm world-api node dist/scripts/seed.js
RUN_DB_INTEGRATION=1 npm run test:integration
node dist/tests/integration/http-acceptance.js
BENCH_MAX_OBJECTS="${BENCH_MAX_OBJECTS:-1000000}" node dist/tests/performance/postgis-benchmark.js
LOAD_DURATION_SECONDS="${LOAD_DURATION_SECONDS:-1}" node dist/tests/performance/http-load.js
MQTT_BENCH_MESSAGES="${MQTT_BENCH_MESSAGES:-1000}" node dist/tests/performance/mqtt-benchmark.js
node dist/scripts/replay.js --subject ugv-001 | tee output/acceptance/replay-ugv-001.json
docker stats --no-stream --format '{{json .}}' > output/benchmarks/docker-stats.jsonl
docker compose exec -T mqtt mosquitto_sub -h localhost -t '$SYS/broker/#' -C 20 -W 5 \
  > output/benchmarks/mosquitto-sys.txt 2>&1 || true

printf '%s\n' "Acceptance passed. Stack remains running for inspection; stop it with: docker compose down"
