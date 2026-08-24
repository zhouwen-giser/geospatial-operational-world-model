#!/usr/bin/env python3
from pathlib import Path
import csv, hashlib, json, sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".").resolve()
from jsonschema import Draft202012Validator, RefResolver

schemas={}
for p in sorted((root/"contracts").glob("*.schema.json")):
    data=json.loads(p.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(data)
    schemas[p.name]=data

required=[
    "common.schema.json",
    "reference-descriptor.schema.json",
    "reference-resolve-request.schema.json",
    "reference-resolve-result.schema.json",
    "operational-task-event.schema.json",
    "operational-task-snapshot.schema.json",
    "correlation-finding.schema.json",
    "external-predicate.schema.json",
    "predicate-evaluation.schema.json",
    "extension-provider-manifest.schema.json",
]
for name in required:
    if name not in schemas:
        raise SystemExit(f"missing schema {name}")

# Validate provider manifests. They do not use cross-file refs.
manifest_validator=Draft202012Validator(schemas["extension-provider-manifest.schema.json"])
for p in sorted((root/"manifests/providers").glob("*.json")):
    data=json.loads(p.read_text(encoding="utf-8"))
    manifest_validator.validate(data)
    for operation in data["operations"]:
        for file_key, hash_key in [
            ("inputSchemaFile","inputSchemaHash"),
            ("outputSchemaFile","outputSchemaHash"),
        ]:
            target=root/operation[file_key]
            if not target.exists():
                raise SystemExit(f"missing operation schema {target}")
            got="sha256:"+hashlib.sha256(target.read_bytes()).hexdigest()
            if got != operation[hash_key]:
                raise SystemExit(f"schema hash mismatch {target}: {got}")

with (root/"acceptance/acceptance-matrix.csv").open(encoding="utf-8",newline="") as f:
    rows=list(csv.DictReader(f))
ids=[r["id"] for r in rows]
if len(ids)!=len(set(ids)):
    raise SystemExit("duplicate acceptance ids")
if not rows:
    raise SystemExit("empty acceptance matrix")

for p in sorted((root/"examples").glob("*.json")):
    json.loads(p.read_text(encoding="utf-8"))

manifest_path=root/"MANIFEST.json"
if manifest_path.exists():
    manifest=json.loads(manifest_path.read_text(encoding="utf-8"))
    for item in manifest["files"]:
        p=root/item["path"]
        if not p.exists():
            raise SystemExit(f"manifest missing {p}")
        b=p.read_bytes()
        if len(b)!=item["bytes"]:
            raise SystemExit(f"manifest size mismatch {p}")
        if hashlib.sha256(b).hexdigest()!=item["sha256"]:
            raise SystemExit(f"manifest hash mismatch {p}")

print(f"TASK_PACKAGE_VALID schemas={len(schemas)} providers={len(list((root/'manifests/providers').glob('*.json')))} examples={len(list((root/'examples').glob('*.json')))} acceptance={len(rows)}")
