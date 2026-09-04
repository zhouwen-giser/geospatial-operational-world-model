#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(node -p "require('$project_dir/package.json').version")"
package_name="gowm-dev-server-${version}"
output_dir="${GOWM_DEPLOYMENT_OUTPUT_DIR:-$project_dir/output/deployment}"
archive_path="$output_dir/${package_name}.tar.gz"
checksum_path="${archive_path}.sha256"

for command_name in node find sort sha256sum tar gzip rg; do
  command -v "$command_name" >/dev/null || { printf 'Missing command: %s\n' "$command_name" >&2; exit 1; }
done

if [[ -e "$archive_path" && "${1:-}" != "--force" ]]; then
  printf 'Refusing to overwrite %s; pass --force to replace it.\n' "$archive_path" >&2
  exit 1
fi

node "$project_dir/scripts/validate-deployment-env.mjs"
if [[ ! -f "$project_dir/artifacts/h3-bindings.mjs" ]]; then
  H3_SOURCE_REPO="${H3_SOURCE_REPO:-$(cd "$project_dir/.." && pwd)/h3-spatial-toolkit}" \
    bash "$project_dir/scripts/dev-deploy.sh" prepare-h3
fi

staging_root="$(mktemp -d)"
staging_dir="$staging_root/$package_name"
cleanup() { rm -rf -- "$staging_root"; }
trap cleanup EXIT
mkdir -p "$staging_dir" "$output_dir"

tar \
  --exclude='./.git' \
  --exclude='./.env' \
  --exclude='*/.env' \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='./tests' \
  --exclude='./test-data' \
  --exclude='*/test' \
  --exclude='*/tests' \
  --exclude='*/fixture' \
  --exclude='*/fixtures' \
  --exclude='*/fixture.*' \
  --exclude='*/fixtures.*' \
  --exclude='*/example' \
  --exclude='*/examples' \
  --exclude='*/example.*' \
  --exclude='*/examples.*' \
  --exclude='./dist' \
  --exclude='./coverage' \
  --exclude='./reports' \
  --exclude='./output' \
  --exclude='./.runtime' \
  --exclude='./.intake' \
  --exclude='./.docker-config' \
  --exclude='*.log' \
  --exclude='*.pid' \
  -cf - -C "$project_dir" . | tar -xf - -C "$staging_dir"

# General reports are intentionally excluded because they can contain local
# runtime evidence. The OpenDRIVE task-network handoff is a versioned,
# deterministic interface consumed by the joint deployment package, so copy
# only that explicitly reviewed subtree when it has been materialized.
opendrive_report_dir="$project_dir/reports/opendrive-task-network-v0.1"
opendrive_report_files=(
  SOURCE_LOCK.json
  COMPILE_REPORT.json
  GDPS_IMPORT_REPORT.json
  GOWM_GRAPH_REPORT.json
  ROUTING_E2E_REPORT.json
  FINAL_ACCEPTANCE_REPORT.json
  README.md
  artifacts/compile-manifest.json
  artifacts/physical-roads.geojson
  artifacts/routing-channels.geojson
  artifacts/allowed-transitions.json
  artifacts/identity-map.json
  artifacts/quarantine.json
  artifacts/compile-report.json
  artifacts/admission-plan.json
  artifacts/SHA256SUMS
)
for report_file in "${opendrive_report_files[@]}"; do
  report_path="$opendrive_report_dir/$report_file"
  [[ -f "$report_path" && ! -L "$report_path" ]] || {
    printf 'Required OpenDRIVE deployment artifact is missing or unsafe: %s\n' "$report_path" >&2
    exit 1
  }
done
mkdir -p "$staging_dir/reports/opendrive-task-network-v0.1"
tar -cf - -C "$opendrive_report_dir" "${opendrive_report_files[@]}" |
  tar -xf - -C "$staging_dir/reports/opendrive-task-network-v0.1"
(cd "$staging_dir/reports/opendrive-task-network-v0.1/artifacts" && sha256sum -c SHA256SUMS >/dev/null)

if rg -n '(postgres(?:ql)?://[^[:space:]@/]+:[^[:space:]@/]+@|Bearer[[:space:]]+[A-Za-z0-9._~+/-]{20,}|/home/)' \
  "$staging_dir/reports/opendrive-task-network-v0.1"; then
  printf '%s\n' 'OpenDRIVE reports contain a credential or host-local path; package aborted.' >&2
  exit 1
fi

# The packaging process uses umask 077 so temporary/private files are never
# exposed while staging. Normalize the distributable tree before archiving:
# Docker build contexts must remain traversable by non-root runtime users.
chmod -R u+rwX,go+rX "$staging_dir"
permission_failure="$(find "$staging_dir" \( -type d ! -perm -005 -o -type f ! -perm -004 \) -print -quit)"
[[ -z "$permission_failure" ]] || { printf 'Unreadable package entry: %s\n' "$permission_failure" >&2; exit 1; }
symlink_failure="$(find "$staging_dir" -type l -print -quit)"
[[ -z "$symlink_failure" ]] || { printf 'Symlinks are forbidden in deployment packages: %s\n' "$symlink_failure" >&2; exit 1; }
env_failure="$(find "$staging_dir" -name .env -print -quit)"
[[ -z "$env_failure" ]] || { printf 'Forbidden .env entry: %s\n' "$env_failure" >&2; exit 1; }
ordinary_sample_failure="$(find "$staging_dir" -type d \( -name test -o -name tests -o -name test-data -o -name fixture -o -name fixtures -o -name example -o -name examples \) -print -quit)"
[[ -z "$ordinary_sample_failure" ]] || {
  printf 'Ordinary test/fixture/example content is forbidden in the deployment package: %s\n' "$ordinary_sample_failure" >&2
  exit 1
}
ordinary_sample_file_failure="$(find "$staging_dir" -type f \( -name 'fixture.*' -o -name 'fixtures.*' -o -name 'example.*' -o -name 'examples.*' \) -print -quit)"
[[ -z "$ordinary_sample_file_failure" ]] || {
  printf 'Ordinary fixture/example file is forbidden in the deployment package: %s\n' "$ordinary_sample_file_failure" >&2
  exit 1
}

(cd "$staging_dir" && find . -type f ! -path './SHA256SUMS' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS)

if rg -n --hidden \
  '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,})' \
  "$staging_dir"; then
  printf '%s\n' 'Potential secret found; package aborted.' >&2
  exit 1
fi

(cd "$staging_dir" && sha256sum -c SHA256SUMS >/dev/null)
tar \
  --sort=name \
  --mtime='UTC 1970-01-01' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -cf - -C "$staging_root" "$package_name" | gzip -n > "$archive_path"
(cd "$output_dir" && sha256sum "$(basename "$archive_path")" > "$(basename "$checksum_path")")
archive_path_failure="$(tar -tzf "$archive_path" | awk '/^\// || /(^|\/)\.\.($|\/)/ { print; exit }')"
[[ -z "$archive_path_failure" ]] || { printf 'Unsafe archive entry: %s\n' "$archive_path_failure" >&2; exit 1; }
printf '%s\n' "$archive_path" "$checksum_path"
