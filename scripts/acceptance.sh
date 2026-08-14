#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-gowm}"
export POSTGRES_PORT="${POSTGRES_PORT:-5432}"
export DATABASE_URL="${DATABASE_URL:-postgresql://gowm:gowm@localhost:${POSTGRES_PORT}/gowm}"

if [[ -z "${COMPOSE_PROJECT_NAME:-}" || "${COMPOSE_PROJECT_NAME}" == *change-to* ]]; then
  printf '%s\n' 'Set an isolated COMPOSE_PROJECT_NAME in .env before acceptance.' >&2
  exit 1
fi

node -e '
  const url=new URL(process.env.DATABASE_URL ?? "");
  if (url.password !== (process.env.POSTGRES_PASSWORD ?? "")) throw new Error("DATABASE_URL password must match POSTGRES_PASSWORD");
  if (url.port !== String(process.env.POSTGRES_PORT ?? "5432")) throw new Error("DATABASE_URL port must match POSTGRES_PORT");
'

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
docker compose exec -T postgres psql -U gowm -d gowm -v ON_ERROR_STOP=1 \
  < database/tests/001_v12_assertions.sql
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
