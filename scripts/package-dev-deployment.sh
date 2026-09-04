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
  --exclude='*.test.ts' \
  --exclude='vitest.config.*' \
  --exclude='./GOWM_Grounding_Operational_Stable_v0.4_Codex_Goal/21_TEST_ACCEPTANCE.md' \
  --exclude='./dist' \
  --exclude='./coverage' \
  --exclude='./reports' \
  --exclude='*/reports' \
  --exclude='./artifacts/opendrive-task-network-v0.1' \
  --exclude='./output' \
  --exclude='./.runtime' \
  --exclude='./.intake' \
  --exclude='./.docker-config' \
  --exclude='*.log' \
  --exclude='*.pid' \
  -cf - -C "$project_dir" . | tar -xf - -C "$staging_dir"

# Reports are intentionally excluded because they can contain local runtime
# evidence. Copy only the versioned OpenDRIVE runtime handoff: its source lock
# and byte-stable compiler artifacts required by compile/admit/verify.
opendrive_runtime_dir="$project_dir/artifacts/opendrive-task-network-v0.1"
opendrive_runtime_files=(
  SOURCE_LOCK.json
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
for runtime_file in "${opendrive_runtime_files[@]}"; do
  runtime_path="$opendrive_runtime_dir/$runtime_file"
  [[ -f "$runtime_path" && ! -L "$runtime_path" ]] || {
    printf 'Required OpenDRIVE runtime artifact is missing or unsafe: %s\n' "$runtime_path" >&2
    exit 1
  }
done
mkdir -p "$staging_dir/artifacts/opendrive-task-network-v0.1"
tar -cf - -C "$opendrive_runtime_dir" "${opendrive_runtime_files[@]}" |
  tar -xf - -C "$staging_dir/artifacts/opendrive-task-network-v0.1"
(cd "$staging_dir/artifacts/opendrive-task-network-v0.1/artifacts" && sha256sum -c SHA256SUMS >/dev/null)

if rg -n '(postgres(?:ql)?://[^[:space:]@/]+:[^[:space:]@/]+@|Bearer[[:space:]]+[A-Za-z0-9._~+/-]{20,}|/home/)' \
  "$staging_dir/artifacts/opendrive-task-network-v0.1"; then
  printf '%s\n' 'OpenDRIVE runtime artifacts contain a credential or host-local path; package aborted.' >&2
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
report_failure="$(find "$staging_dir" -type d -name reports -print -quit)"
[[ -z "$report_failure" ]] || { printf 'Reports are forbidden in deployment packages: %s\n' "$report_failure" >&2; exit 1; }
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
test_source_failure="$(find "$staging_dir" -type f \( -name '*.test.ts' -o -name 'vitest.config.*' \) -print -quit)"
[[ -z "$test_source_failure" ]] || {
  printf 'Test source is forbidden in the deployment package: %s\n' "$test_source_failure" >&2
  exit 1
}
test_acceptance_document="$staging_dir/GOWM_Grounding_Operational_Stable_v0.4_Codex_Goal/21_TEST_ACCEPTANCE.md"
[[ ! -e "$test_acceptance_document" ]] || {
  printf 'Test acceptance source document is forbidden in the deployment package: %s\n' "$test_acceptance_document" >&2
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
archive_test_source_failure="$(tar -tzf "$archive_path" | rg '(^|/)([^/]+\.test\.ts|vitest\.config\.[^/]+|21_TEST_ACCEPTANCE\.md)$' | head -n 1 || true)"
[[ -z "$archive_test_source_failure" ]] || {
  printf 'Forbidden test source escaped into the deployment archive: %s\n' "$archive_test_source_failure" >&2
  exit 1
}
archive_ordinary_sample_failure="$(tar -tzf "$archive_path" | rg '(^|/)(test|tests|test-data|fixture|fixtures|example|examples)(/|$)' | head -n 1 || true)"
[[ -z "$archive_ordinary_sample_failure" ]] || {
  printf 'Forbidden test/fixture/example directory escaped into the deployment archive: %s\n' "$archive_ordinary_sample_failure" >&2
  exit 1
}
archive_ordinary_sample_file_failure="$(tar -tzf "$archive_path" | rg '(^|/)(fixture|fixtures|example|examples)\.[^/]+$' | head -n 1 || true)"
[[ -z "$archive_ordinary_sample_file_failure" ]] || {
  printf 'Forbidden fixture/example file escaped into the deployment archive: %s\n' "$archive_ordinary_sample_file_failure" >&2
  exit 1
}
archive_report_failure="$(tar -tzf "$archive_path" | rg '(^|/)reports(/|$)' | head -n 1 || true)"
[[ -z "$archive_report_failure" ]] || {
  printf 'Forbidden reports directory escaped into the deployment archive: %s\n' "$archive_report_failure" >&2
  exit 1
}
printf '%s\n' "$archive_path" "$checksum_path"
