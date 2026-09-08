#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(node -p "require('$project_dir/package.json').version")"
package_name="gowm-dev-server-${version}"
output_dir="${GOWM_DEPLOYMENT_OUTPUT_DIR:-$project_dir/output/deployment}"
archive_path="$output_dir/${package_name}.tar.gz"
checksum_path="${archive_path}.sha256"
force=false
verify_image=false
for argument in "$@"; do
  case "$argument" in
    --force) force=true ;;
    --verify-image) verify_image=true ;;
    *) printf 'Usage: %s [--force] [--verify-image]\n' "$0" >&2; exit 2 ;;
  esac
done

for command_name in node find sort sha256sum tar gzip rg git; do
  command -v "$command_name" >/dev/null || { printf 'Missing command: %s\n' "$command_name" >&2; exit 1; }
done

if [[ -e "$archive_path" && "$force" != true ]]; then
  printf 'Refusing to overwrite %s; pass --force to replace it.\n' "$archive_path" >&2
  exit 1
fi

node "$project_dir/scripts/validate-deployment-env.mjs"
node "$project_dir/scripts/verify-ugv-bootstrap-package.mjs" "$project_dir"
if [[ ! -f "$project_dir/artifacts/h3-bindings.mjs" ]]; then
  H3_SOURCE_REPO="${H3_SOURCE_REPO:-$(cd "$project_dir/.." && pwd)/h3-spatial-toolkit}" \
    bash "$project_dir/scripts/dev-deploy.sh" prepare-h3
fi

staging_root="$(mktemp -d)"
staging_dir="$staging_root/$package_name"
cleanup() { rm -rf -- "$staging_root"; }
trap cleanup EXIT
mkdir -p "$staging_dir" "$output_dir"

# Only tracked files may enter the package. The inventory also
# rejects local/private paths even if they were accidentally staged.
node "$project_dir/scripts/dev-deployment-inventory.mjs" "$project_dir" > "$staging_root/files.list"
tar -cf - -C "$project_dir" --null --verbatim-files-from --no-recursion \
  -T "$staging_root/files.list" | tar -xf - -C "$staging_dir"

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
  git -C "$project_dir" ls-files --error-unmatch -- "artifacts/opendrive-task-network-v0.1/$runtime_file" >/dev/null
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
# SHA256SUMS is created after the tree normalization, under umask 077.
chmod 0644 "$staging_dir/SHA256SUMS"

if rg -n --hidden \
  '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,})' \
  "$staging_dir"; then
  printf '%s\n' 'Potential secret found; package aborted.' >&2
  exit 1
fi

(cd "$staging_dir" && sha256sum -c SHA256SUMS >/dev/null)
# Never replace the previous deliverable until every requested gate succeeds.
final_archive_path="$archive_path"
final_checksum_path="$checksum_path"
archive_path="$staging_root/${package_name}.tar.gz"
checksum_path="${archive_path}.sha256"
tar \
  --sort=name \
  --mtime='UTC 1970-01-01' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -cf - -C "$staging_root" "$package_name" | gzip -n > "$archive_path"
(cd "$staging_root" && sha256sum "$(basename "$archive_path")" > "$(basename "$checksum_path")")
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
mkdir "$staging_root/verify"
tar --same-permissions -xzf "$archive_path" -C "$staging_root/verify"
verified_dir="$staging_root/verify/$package_name"
(cd "$verified_dir" && sha256sum -c SHA256SUMS >/dev/null)
permission_failure="$(find "$verified_dir" \( -type d ! -perm -005 -o -type f ! -perm -004 \) -print -quit)"
[[ -z "$permission_failure" ]] || { printf 'Unreadable archived entry: %s\n' "$permission_failure" >&2; exit 1; }
for entrypoint in scripts/dev-deploy.sh scripts/opendrive-task-network.sh; do
  [[ -x "$verified_dir/$entrypoint" ]]
  bash -n "$verified_dir/$entrypoint"
done
(cd "$verified_dir" && node scripts/validate-deployment-env.mjs && node scripts/verify-ugv-bootstrap-package.mjs && bash scripts/opendrive-task-network.sh --help >/dev/null)
tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
  -cf - -C "$staging_root/verify" "$package_name" | gzip -n > "$staging_root/reproduced.tar.gz"
cmp "$archive_path" "$staging_root/reproduced.tar.gz"
if [[ "$verify_image" == true ]]; then
  image_tag="gowm-dev-package-check:$(sha256sum "$archive_path" | cut -c1-16)"
  bash "$project_dir/scripts/build-verified-image.sh" "$image_tag" "$verified_dir"
  docker run --rm --network none --read-only --entrypoint node "$image_tag" -e '
    const fs = require("node:fs");
    if (process.getuid() === 0) throw new Error("Runtime must be non-root");
    const migrations = fs.readdirSync("/app/database/migrations");
    if (!migrations.length) throw new Error("Missing migrations");
    for (const file of migrations) fs.accessSync("/app/database/migrations/" + file, fs.constants.R_OK);
    fs.accessSync("/app/dist/scripts/migrate.js", fs.constants.R_OK);
    fs.accessSync("/app/dist/scripts/world-object-catalog-backfill.js", fs.constants.R_OK);
    fs.accessSync("/app/dist/scripts/business-storage/cli.js", fs.constants.R_OK);
    fs.accessSync("/app/dist/scripts/business-storage/device-cli.js", fs.constants.R_OK);
    fs.accessSync("/app/dist/scripts/business-storage/accounts.js", fs.constants.R_OK);
    fs.accessSync("/app/database/migrations/078_device_shared_business_storage.sql", fs.constants.R_OK);
    fs.accessSync("/app/database/migrations/079_device_context_reader.sql", fs.constants.R_OK);
    const hosted = JSON.parse(fs.readFileSync("/app/database/shared-business-storage/install-manifest.json", "utf8"));
    for (const entry of hosted.entries) fs.accessSync("/app/database/shared-business-storage/" + entry.generatedPath, fs.constants.R_OK);
    for (const entry of hosted.overlays) fs.accessSync("/app/database/shared-business-storage/" + entry.path, fs.constants.R_OK);
    console.log("PASS: non-root runtime can read migrations");
  '
  docker run --rm --network none --read-only --entrypoint node "$image_tag" \
    dist/scripts/business-storage/cli.js install --help
  docker run --rm --network none --read-only --entrypoint node "$image_tag" \
    dist/scripts/business-storage/device-cli.js init-default --help
  docker run --rm --network none --read-only --entrypoint node "$image_tag" \
    dist/scripts/business-storage/accounts.js --help
fi
if [[ -e "$final_archive_path" ]]; then
  backup_dir="$(mktemp -d "$output_dir/previous-${package_name}.XXXXXX")"
  cp -p "$final_archive_path" "$backup_dir/"
  if [[ -e "$final_checksum_path" ]]; then cp -p "$final_checksum_path" "$backup_dir/"; fi
  printf 'Previous package preserved: %s\n' "$backup_dir"
fi
chmod 0644 "$archive_path" "$checksum_path"
mv "$archive_path" "$final_archive_path"
mv "$checksum_path" "$final_checksum_path"
(cd "$output_dir" && sha256sum -c "$(basename "$final_checksum_path")")
printf 'PASS: archive checksums, permissions, exclusions, entrypoints and reproducibility\n'
printf '%s\n' "$final_archive_path" "$final_checksum_path"
