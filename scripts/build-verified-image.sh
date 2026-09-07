#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $# -eq 2 ]] || { echo 'Usage: build-verified-image.sh <image-tag> <verified-package-directory>' >&2; exit 2; }
image_tag="$1"
context_dir="$(cd "$2" && pwd)"
# Validate the immutable inventory and send only those files. Deployment .env
# and local runtime evidence must never be uploaded to the Docker builder.
(cd "$context_dir" && sha256sum -c SHA256SUMS >/dev/null)
node --input-type=module -e '
  import fs from "node:fs";
  const files=fs.readFileSync(process.argv[1]+"/SHA256SUMS","utf8").trimEnd().split("\n").map(line=>{
    const match=/^[a-f0-9]{64}  (\.\/.*)$/.exec(line);
    if(!match||match[1].split("/").includes("..")) throw new Error("Unsafe checksum inventory");
    return match[1];
  });
  process.stdout.write([...files,"./SHA256SUMS"].join("\0")+"\0");
' "$context_dir" | tar -C "$context_dir" --null --verbatim-files-from --no-recursion -T - -cf - |
  docker build --tag "$image_tag" -
node "$script_dir/verify-deployment-image.mjs" "$image_tag" "$context_dir"
