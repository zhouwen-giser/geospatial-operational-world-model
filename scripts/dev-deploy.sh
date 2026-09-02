#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${GOWM_DEV_ENV_FILE:-$project_dir/.env}"
runtime_dir="$project_dir/.runtime/dev-deploy"
artifact_dir="$project_dir/artifacts"
compose_files=(
  -f "$project_dir/docker-compose.yml"
  -f "$project_dir/docker-compose.world-platform.yml"
  -f "$project_dir/docker-compose.dev.yml"
)
compose_profiles=(--profile foundation-admin --profile world-platform)

log() { printf '[gowm-dev] %s\n' "$*"; }
fail() { printf '[gowm-dev] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }

env_value() {
  local key="$1" file="${2:-$env_file}"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

set_env() {
  local key="$1" value="$2" file="${3:-$env_file}" tmp
  tmp="$(mktemp "${file}.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { found=0 }
    $0 ~ "^" key "=" { print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$file" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

compose() {
  docker compose --env-file "$env_file" "${compose_files[@]}" "${compose_profiles[@]}" "$@"
}

random_secret() {
  openssl rand -hex 32
}

init_env() {
  need awk
  need mktemp
  need openssl
  if [[ ! -f "$env_file" ]]; then
    cp "$project_dir/.env.example" "$env_file"
    chmod 600 "$env_file"
  fi

  local secret_vars=(
    POSTGRES_PASSWORD STAS_DB_PASSWORD HISTORICAL_WORKER_DB_PASSWORD
    GATEWAY_DB_PASSWORD GATEWAY_REGISTRY_DB_PASSWORD SPATIAL_DB_PASSWORD SITUATION_DB_PASSWORD
    REFERENCE_DB_PASSWORD CATALOG_DB_PASSWORD EVIDENCE_DB_PASSWORD OPERATIONAL_DB_PASSWORD
    HISTORICAL_DB_PASSWORD VALIDATION_DB_PASSWORD NETWORK_DB_PASSWORD ROUTE_DB_PASSWORD COVERAGE_DB_PASSWORD
    GATEWAY_AUTH_SHARED_TOKEN GROUNDING_CURSOR_HMAC_SECRET SPATIAL_CURSOR_HMAC_SECRET
    CRS_PROVIDER_TRANSPORT_TOKEN GEOMETRY_PROVIDER_TRANSPORT_TOKEN
    DATASET_CATALOG_PROVIDER_TRANSPORT_TOKEN NETWORK_PROVIDER_TRANSPORT_TOKEN
    OPERATIONAL_REALITY_PROVIDER_TRANSPORT_TOKEN HISTORICAL_TRACE_PROVIDER_TRANSPORT_TOKEN
    PLATFORM_VALIDATION_PROVIDER_TRANSPORT_TOKEN REFERENCE_CATALOG_PROVIDER_TRANSPORT_TOKEN
    COVERAGE_PROVIDER_TRANSPORT_TOKEN ROUTE_PROVIDER_TRANSPORT_TOKEN STAS_PROVIDER_TRANSPORT_TOKEN
    WORLD_EVIDENCE_PROVIDER_TRANSPORT_TOKEN H3_INTERACTIVE_PROVIDER_TRANSPORT_TOKEN
    H3_ANALYSIS_PROVIDER_TRANSPORT_TOKEN SPATIAL_PROVIDER_TRANSPORT_TOKEN SITUATION_PROVIDER_TRANSPORT_TOKEN
  )
  local key current
  for key in "${secret_vars[@]}"; do
    current="$(env_value "$key")"
    if [[ -z "$current" || "$current" =~ ^(replace|REPLACE) ]]; then
      set_env "$key" "$(random_secret)"
    fi
  done

  local postgres_password
  postgres_password="$(env_value POSTGRES_PASSWORD)"
  set_env DATABASE_URL "postgresql://gowm:${postgres_password}@localhost:$(env_value POSTGRES_PORT)/gowm"
  if [[ "$(env_value COMPOSE_PROJECT_NAME)" =~ (change|local) ]] || [[ -z "$(env_value COMPOSE_PROJECT_NAME)" ]]; then
    set_env COMPOSE_PROJECT_NAME "gowm-dev-$(date -u +%Y%m%d%H%M%S)"
  fi
  set_env DEV_BIND_ADDRESS "${GOWM_DEV_BIND_ADDRESS:-$(env_value DEV_BIND_ADDRESS)}"
  [[ -n "$(env_value DEV_BIND_ADDRESS)" ]] || set_env DEV_BIND_ADDRESS "0.0.0.0"
  chmod 600 "$env_file"
  log "environment ready at $env_file"
}

approved_h3_digest() {
  node -e '
    const lock=require(process.argv[1]);
    process.stdout.write(lock.bindingsArtifactPolicy.approvedArtifactDigests[0] || "");
  ' "$project_dir/contracts/manifests/providers/h3-toolkit-source-lock.json"
}

prepare_h3() {
  need sha256sum
  mkdir -p "$artifact_dir" "$runtime_dir"
  local output="$artifact_dir/h3-bindings.mjs" expected actual source_repo commit
  expected="$(approved_h3_digest)"
  [[ -n "$expected" ]] || fail "approved H3 binding digest is missing from source lock"

  if [[ ! -f "$output" ]]; then
    need node
    need npm
    need git
    if [[ ! -d "$project_dir/node_modules/esbuild" ]]; then
      log "installing locked Node dependencies for H3 binding build"
      (cd "$project_dir" && npm ci --ignore-scripts)
    fi
    source_repo="${H3_SOURCE_REPO:-$runtime_dir/h3-spatial-toolkit}"
    commit="$(node -e 'const l=require(process.argv[1]);process.stdout.write(l.sourceGitCommit)' "$project_dir/contracts/manifests/providers/h3-toolkit-source-lock.json")"
    if [[ ! -d "$source_repo/.git" ]]; then
      git clone --no-checkout https://github.com/zhouwen-giser/h3-spatial-toolkit.git "$source_repo"
    fi
    git -C "$source_repo" fetch --depth 1 origin "$commit"
    git -C "$source_repo" checkout --detach "$commit"
    node "$project_dir/scripts/build-locked-h3-bindings.mjs" \
      --source-repo "$source_repo" \
      --out "$output" \
      --report "$runtime_dir/h3-bindings-build-report.json"
  fi

  actual="sha256:$(sha256sum "$output" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || fail "H3 binding digest mismatch: expected $expected, got $actual"
  set_env H3_TOOLKIT_BINDINGS_HOST_PATH "$output"
  set_env H3_TOOLKIT_BINDINGS_MODULE_HOST_PATH "$output"
  set_env H3_TOOLKIT_BINDINGS_MODULE_SHA256 "$actual"
  log "H3 binding verified: $actual"
}

crs_proj_db_digest() {
  local image="$1"
  docker run --rm --entrypoint node "$image" -e '
    const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");
    const found=[];
    const walk=(p)=>{for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory())walk(q);else if(e.name==="proj.db")found.push(q)}};
    walk("/app/node_modules/gdal-async");
    if(found.length!==1)throw new Error(`expected one proj.db, found ${found.length}`);
    process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(found[0])).digest("hex"));
  '
}

crs_grid_digest() {
  local grid_dir="$project_dir/services/upstreams/crs-normalization-service/grids"
  local manifest="$runtime_dir/crs-grid-manifest.txt"
  find "$grid_dir" -type f ! -name README.md -print0 | sort -z | xargs -0 -r sha256sum > "$manifest"
  sha256sum "$manifest" | awk '{print $1}'
}

prepare_crs_attestation() {
  local image proj_hash grid_hash grid_count
  image="$(env_value CRS_UPSTREAM_IMAGE)"
  [[ -n "$image" ]] || image="gowm-crs-normalization-service:1.0.0"
  log "building CRS and Geometry upstream images"
  compose build crs-upstream geometry-upstream
  proj_hash="$(crs_proj_db_digest "$image")"
  grid_hash="$(crs_grid_digest)"
  grid_count="$(find "$project_dir/services/upstreams/crs-normalization-service/grids" -type f ! -name README.md | wc -l | tr -d ' ')"
  set_env CRS_PROJ_DB_VERSION "PROJ-9.5.1-bundled"
  set_env CRS_PROJ_DB_SHA256 "sha256:$proj_hash"
  if [[ "$grid_count" == "0" ]]; then
    set_env CRS_GRID_BUNDLE_VERSION "none"
  else
    set_env CRS_GRID_BUNDLE_VERSION "custom-${grid_hash:0:12}"
  fi
  set_env CRS_GRID_BUNDLE_SHA256 "sha256:$grid_hash"
  log "CRS deployment artifacts attested"
}

doctor() {
  need docker
  need awk
  need sha256sum
  docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable"
  docker compose version >/dev/null
  need node
  node "$project_dir/scripts/validate-deployment-env.mjs"
  if [[ -f "$env_file" ]]; then
    compose config --quiet
    if command -v ss >/dev/null 2>&1 && [[ -z "$(compose ps -q 2>/dev/null)" ]]; then
      local port_vars=(
        POSTGRES_PORT MQTT_PORT WORLD_API_PORT OBSERVATION_API_PORT MCP_PORT STAS_PORT GATEWAY_PORT
        CRS_UPSTREAM_PUBLISHED_PORT GEOMETRY_UPSTREAM_PUBLISHED_PORT CRS_BRIDGE_PUBLISHED_PORT
        GEOMETRY_BRIDGE_PUBLISHED_PORT H3_INTERACTIVE_PUBLISHED_PORT H3_ANALYSIS_PUBLISHED_PORT
        REFERENCE_PROVIDER_PUBLISHED_PORT DATASET_PROVIDER_PUBLISHED_PORT SITUATION_PROVIDER_PUBLISHED_PORT
        EVIDENCE_PROVIDER_PUBLISHED_PORT OPERATIONAL_PROVIDER_PUBLISHED_PORT VALIDATION_PROVIDER_PUBLISHED_PORT
        NETWORK_PROVIDER_PUBLISHED_PORT ROUTE_PROVIDER_PUBLISHED_PORT COVERAGE_PROVIDER_PUBLISHED_PORT
        STAS_PROVIDER_PUBLISHED_PORT HISTORICAL_PROVIDER_PUBLISHED_PORT SPATIAL_PROVIDER_PUBLISHED_PORT
      )
      local key port
      for key in "${port_vars[@]}"; do
        port="$(env_value "$key")"
        if [[ "$port" =~ ^[0-9]+$ ]] && ss -H -ltn | awk -v port="$port" '$4 ~ (":" port "$") { found=1 } END { exit(found ? 0 : 1) }'; then
          fail "host port $port ($key) is already in use"
        fi
      done
    fi
  else
    docker compose --env-file "$project_dir/.env.world-platform.example" \
      "${compose_files[@]}" "${compose_profiles[@]}" config --quiet
  fi
  log "preflight checks passed"
}

smoke() {
  need curl
  local checks=(
    "${WORLD_API_PORT:-$(env_value WORLD_API_PORT)}:/health"
    "${OBSERVATION_API_PORT:-$(env_value OBSERVATION_API_PORT)}:/health"
    "${MCP_PORT:-$(env_value MCP_PORT)}:/health"
    "${STAS_PORT:-$(env_value STAS_PORT)}:/readyz"
    "${GATEWAY_PORT:-$(env_value GATEWAY_PORT)}:/health/ready"
    "$(env_value CRS_UPSTREAM_PUBLISHED_PORT):/health/ready"
    "$(env_value GEOMETRY_UPSTREAM_PUBLISHED_PORT):/ready"
    "$(env_value CRS_BRIDGE_PUBLISHED_PORT):/health/ready"
    "$(env_value GEOMETRY_BRIDGE_PUBLISHED_PORT):/health/ready"
  )
  local check port path
  for check in "${checks[@]}"; do
    port="${check%%:*}"
    path="${check#*:}"
    curl --fail --silent --show-error "http://127.0.0.1:${port}${path}" >/dev/null
  done
  log "public health probes passed"
}

up() {
  init_env
  prepare_h3
  prepare_crs_attestation
  doctor
  local timeout
  timeout="$(env_value DEV_HEALTH_TIMEOUT_SECONDS)"
  [[ "$timeout" =~ ^[0-9]+$ ]] || timeout=600
  log "building and starting the complete development platform"
  compose up -d --build --wait --wait-timeout "$timeout"
  smoke
  log "deployment is ready; endpoints are documented in docs/DEV_DEPLOYMENT.md"
  log "Gateway token remains private in $env_file (GATEWAY_AUTH_SHARED_TOKEN)"
}

usage() {
  printf '%s\n' 'Usage: scripts/dev-deploy.sh [up|init|doctor|prepare-h3|prepare-artifacts|status|logs|down|smoke] [service...]'
}

command_name="${1:-up}"
shift || true
case "$command_name" in
  up) up ;;
  init) init_env ;;
  doctor) doctor ;;
  prepare-h3) init_env; prepare_h3 ;;
  prepare-artifacts) init_env; prepare_h3; prepare_crs_attestation ;;
  status) init_env; compose ps ;;
  logs) init_env; compose logs --tail 200 "$@" ;;
  down) init_env; compose down ;;
  smoke) init_env; smoke ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
