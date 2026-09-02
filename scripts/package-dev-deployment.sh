#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(node -p "require('$project_dir/package.json').version")"
package_name="gowm-dev-server-${version}"
output_dir="${GOWM_DEPLOYMENT_OUTPUT_DIR:-$project_dir/output/deployment}"
archive_path="$output_dir/${package_name}.tar.gz"
checksum_path="${archive_path}.sha256"

for command_name in node find sort sha256sum tar rg; do
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
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
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

# The packaging process uses umask 077 so temporary/private files are never
# exposed while staging. Normalize the distributable tree before archiving:
# Docker build contexts must remain traversable by non-root runtime users.
chmod -R u+rwX,go+rX "$staging_dir"
permission_failure="$(find "$staging_dir" \( -type d ! -perm -005 -o -type f ! -perm -004 \) -print -quit)"
[[ -z "$permission_failure" ]] || { printf 'Unreadable package entry: %s\n' "$permission_failure" >&2; exit 1; }

(cd "$staging_dir" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

if rg -n --hidden \
  '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,})' \
  "$staging_dir"; then
  printf '%s\n' 'Potential secret found; package aborted.' >&2
  exit 1
fi

(cd "$staging_dir" && sha256sum -c SHA256SUMS >/dev/null)
tar -czf "$archive_path" -C "$staging_root" "$package_name"
(cd "$output_dir" && sha256sum "$(basename "$archive_path")" > "$(basename "$checksum_path")")
tar -tzf "$archive_path" >/dev/null
printf '%s\n' "$archive_path" "$checksum_path"
