#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

test -f CODEX_MASTER_PROMPT.md
test -f dependencies/source-lock.json
test -f acceptance/acceptance-matrix.csv

command -v git
command -v python3
command -v node || true
command -v npm || true
command -v docker || true
command -v psql || true

echo "== Locked source =="
python3 - <<'PY'
import json
from pathlib import Path
s=json.loads(Path("dependencies/source-lock.json").read_text())
print(json.dumps(s, indent=2))
PY

echo "PREFLIGHT_PASS"
