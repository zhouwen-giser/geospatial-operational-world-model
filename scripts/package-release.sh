#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_name="gowm-stas-platform-v0.1.0"
archive_path="${1:-$(dirname "$project_dir")/${project_name}.zip}"

if [[ -e "$project_dir/.env" ]]; then
  printf '%s\n' 'Refusing to package local .env' >&2
  exit 1
fi
if [[ -e "$archive_path" ]]; then
  printf 'Refusing to overwrite %s\n' "$archive_path" >&2
  exit 1
fi
for command_name in find sort sha256sum zip unzip tar rg; do
  command -v "$command_name" >/dev/null || { printf 'Missing command: %s\n' "$command_name" >&2; exit 1; }
done

checksum_tmp="$(mktemp)"
staging_dir="$(mktemp -d)"
cleanup() { rm -rf -- "$staging_dir"; rm -f -- "$checksum_tmp"; }
trap cleanup EXIT

cd "$project_dir"
find . -type f \
  ! -path './node_modules/*' ! -path './dist/*' ! -path './coverage/*' \
  ! -path './output/runtime/*' ! -path './.git/*' ! -path './.intake/*' \
  ! -path './.docker-config/*' ! -name '.env' \
  ! -name 'SHA256SUMS' ! -name '*.zip' -print0 \
  | sort -z | xargs -0 sha256sum | sed 's#  \./#  #' > "$checksum_tmp"
mv "$checksum_tmp" SHA256SUMS

mkdir -p "$staging_dir/$project_name"
tar --exclude='./node_modules' --exclude='./dist' --exclude='./coverage' \
  --exclude='./output/runtime' --exclude='./.git' --exclude='./.intake' \
  --exclude='./.docker-config' --exclude='./.env' --exclude='*.zip' \
  -cf - . | tar -xf - -C "$staging_dir/$project_name"

if rg -n --hidden --glob '!SHA256SUMS' \
  '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,})' \
  "$staging_dir/$project_name"; then
  printf '%s\n' 'Potential secret found; package aborted' >&2
  exit 1
fi

(cd "$staging_dir/$project_name" && sha256sum -c SHA256SUMS >/dev/null)
(cd "$staging_dir" && zip -q -r "$archive_path" "$project_name")
unzip -t "$archive_path" >/dev/null
printf '%s  %s\n' "$(sha256sum "$archive_path" | awk '{print $1}')" "$(basename "$archive_path")"
