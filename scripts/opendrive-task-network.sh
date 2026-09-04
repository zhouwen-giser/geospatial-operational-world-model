#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${GOWM_OPENDRIVE_IMAGE:-gowm-opendrive-task-network:0.7.1}"

usage() {
  cat <<'EOF'
Usage:
  opendrive-task-network.sh compile [<xodr> <oracle.py> <artifact-dir>]
  opendrive-task-network.sh admit [<artifact-dir>] [--show-db-fingerprint]
  opendrive-task-network.sh verify [<artifact-dir>]
  opendrive-task-network.sh validate [<artifact-dir>]  # require a Provider PASS

The three compile arguments may instead be supplied through
OPENDRIVE_SOURCE_PATH, OPENDRIVE_GEOREF_ORACLE_PATH, and
GOWM_OPENDRIVE_OUTPUT_ROOT. admit and verify read GOWM_OPENDRIVE_OUTPUT_ROOT
when artifact-dir is omitted. The host does not need Node.js dependencies;
the management CLI is built and run in a locked-down Docker container.
EOF
}

fail() {
  printf 'OpenDRIVE command failed: %s\n' "$1" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing host command: $1"
}

absolute_existing_file() {
  local input="$1" label="$2" resolved
  [[ -n "$input" ]] || fail "$label is required"
  [[ "$input" = /* ]] || fail "$label must be an absolute path"
  [[ -f "$input" && ! -L "$input" ]] || fail "$label must be a regular, non-symlink file: $input"
  resolved="$(realpath -- "$input")"
  [[ "$resolved" != *','* && "$resolved" != *$'\n'* ]] || fail "$label contains a character unsupported by Docker bind mounts"
  printf '%s\n' "$resolved"
}

absolute_artifact_dir() {
  local input="$1" candidate resolved parent
  [[ -n "$input" ]] || fail "artifact directory is required"
  [[ "$input" = /* ]] || fail "artifact directory must be an absolute path"
  [[ ! -L "$input" ]] || fail "artifact directory must not be a symlink: $input"
  candidate="$(realpath -m -- "$input")"
  parent="$(dirname -- "$candidate")"
  [[ "$candidate" != / && "$parent" != / ]] || fail "artifact directory must not be / or a direct child of /"
  [[ "$candidate" != *','* && "$candidate" != *$'\n'* ]] || fail "artifact directory contains a character unsupported by Docker bind mounts"
  mkdir -p -- "$candidate"
  [[ -d "$candidate" && ! -L "$candidate" ]] || fail "artifact directory must be a non-symlink directory: $candidate"
  resolved="$(realpath -- "$candidate")"
  printf '%s\n' "$resolved"
}

build_management_image() {
  docker build --target runtime --tag "$image" "$project_dir"
}

container_security_args=(
  --rm
  --init
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges:true
  --tmpfs /tmp:rw,noexec,nosuid,size=64m
  --user "$(id -u):$(id -g)"
)

pass_environment=()
for variable in \
  GOWM_OPENDRIVE_DATA_SCOPE_KEY \
  GOWM_OPENDRIVE_DATASET_SCOPE_KEY \
  GOWM_OPENDRIVE_GRAPH_KEY \
  GOWM_OPENDRIVE_DATABASE_URL \
  GOWM_OPENDRIVE_EXPECTED_DB_FINGERPRINT \
  GOWM_OPENDRIVE_ALLOW_DB_MUTATION \
  GOWM_OPENDRIVE_ALLOW_DEVELOPMENT_DATABASE \
  GOWM_OPENDRIVE_EXPECTED_COMPOSE_PROJECT \
  COMPOSE_PROJECT_NAME \
  GOWM_OPENDRIVE_NETWORK_PROVIDER_URL \
  GOWM_OPENDRIVE_NETWORK_PROVIDER_TOKEN; do
  if [[ -n "${!variable:-}" ]]; then
    pass_environment+=(--env "$variable")
  fi
done

require_command docker
require_command realpath
require_command id

action="${1:-}"
[[ -n "$action" ]] || { usage >&2; exit 2; }
shift

case "$action" in
  compile)
    source_path="${1:-${OPENDRIVE_SOURCE_PATH:-}}"
    oracle_path="${2:-${OPENDRIVE_GEOREF_ORACLE_PATH:-}}"
    output_path="${3:-${GOWM_OPENDRIVE_OUTPUT_ROOT:-}}"
    [[ $# -le 3 ]] || fail "compile accepts at most three positional arguments"
    source_path="$(absolute_existing_file "$source_path" OPENDRIVE_SOURCE_PATH)"
    oracle_path="$(absolute_existing_file "$oracle_path" OPENDRIVE_GEOREF_ORACLE_PATH)"
    output_path="$(absolute_artifact_dir "$output_path")"
    output_parent="$(dirname -- "$output_path")"
    output_name="$(basename -- "$output_path")"
    build_management_image
    docker run "${container_security_args[@]}" \
      --network none \
      --mount "type=bind,src=$source_path,dst=/inputs/source.xodr,readonly" \
      --mount "type=bind,src=$oracle_path,dst=/inputs/oracle.py,readonly" \
      --mount "type=bind,src=$output_parent,dst=/handoff" \
      "$image" node dist/scripts/opendrive/cli.js compile \
      /inputs/source.xodr /inputs/oracle.py "/handoff/$output_name"
    ;;
  admit|verify|validate)
    if [[ $# -gt 0 && "${1:-}" != --* ]]; then
      output_path="$1"
      shift
    else
      output_path="${GOWM_OPENDRIVE_OUTPUT_ROOT:-}"
    fi
    output_path="$(absolute_artifact_dir "$output_path")"
    output_parent="$(dirname -- "$output_path")"
    output_name="$(basename -- "$output_path")"
    docker_network="${GOWM_OPENDRIVE_DOCKER_NETWORK:-host}"
    build_management_image
    docker run "${container_security_args[@]}" \
      --network "$docker_network" \
      --mount "type=bind,src=$output_parent,dst=/handoff" \
      --env "GOWM_OPENDRIVE_OUTPUT_ROOT=/handoff/$output_name" \
      "${pass_environment[@]}" \
      "$image" node dist/scripts/opendrive/cli.js "$action" \
      "/handoff/$output_name" "$@"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    fail "unknown action: $action"
    ;;
esac
