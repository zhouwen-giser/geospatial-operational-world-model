#!/usr/bin/env python3
"""Verify this task package only. Does NOT validate GOWM code or a PostgreSQL database."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    errors: list[str] = []
    sums = root / "SHA256SUMS.txt"
    if not sums.is_file():
        print(json.dumps({"status": "FAIL", "errors": ["SHA256SUMS.txt missing"]}))
        return 1
    expected: dict[str, str] = {}
    for line in sums.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            digest, relative = line.split("  ", 1)
            path = (root / relative).resolve()
            if not path.is_relative_to(root) or relative in expected:
                raise ValueError("invalid or duplicate relative path")
            if len(digest) != 64:
                raise ValueError("invalid sha256")
            expected[relative] = digest
        except ValueError as exc:
            errors.append(f"Invalid checksum line: {exc}")
            continue
        if not path.is_file():
            errors.append(f"Missing: {relative}")
        elif hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            errors.append(f"Hash mismatch: {relative}")

    actual = {
        p.relative_to(root).as_posix()
        for p in root.rglob("*")
        if p.is_file() and p.name != "SHA256SUMS.txt"
    }
    if actual != set(expected):
        errors.append("Checksum inventory does not match actual package files")

    for relative in sorted(actual):
        if relative.endswith(".json"):
            try:
                json.loads((root / relative).read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                errors.append(f"Invalid JSON {relative}: {exc}")

    try:
        meta = json.loads((root / "task.json").read_text(encoding="utf-8"))
        model = json.loads((root / "data-model-contract.json").read_text(encoding="utf-8"))
        acceptance = json.loads((root / "acceptance.json").read_text(encoding="utf-8"))["items"]
        cases = json.loads((root / "test-scenarios.json").read_text(encoding="utf-8"))["scenarios"]
        manifest = json.loads((root / "PACKAGE_MANIFEST.json").read_text(encoding="utf-8"))

        checks = {
            "fixed business schemas": model["sharedBusinessSchemas"] == ["ugv_smpp", "ugv_sdar"],
            "GOWM write scope": meta["writeScope"] == ["geospatial-operational-world-model"],
            "nine unique public tables": len({x["name"] for x in model["tables"]}) == 9,
            "no instance storage routing": model["instanceControlsBusinessStorage"] is False,
            "runtime cutover excluded": model["applicationCutoverIncluded"] is False,
            "40 acceptance items": len(acceptance) == meta["acceptanceCount"] == 40,
            "36 test scenarios": len(cases) == meta["scenarioCount"] == 36,
            "eight phases": len(meta["phases"]) == 8,
            "unique acceptance IDs": len({x["id"] for x in acceptance}) == len(acceptance),
            "unique case IDs": len({x["id"] for x in cases}) == len(cases),
        }
        errors.extend(name for name, passed in checks.items() if not passed)
        for item in manifest["files"]:
            path = root / item["path"]
            if not path.is_file():
                errors.append(f"Manifest missing: {item['path']}")
                continue
            data = path.read_bytes()
            if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
                errors.append(f"Manifest mismatch: {item['path']}")
    except (KeyError, OSError, ValueError) as exc:
        errors.append(f"Package metadata validation: {exc}")

    print(json.dumps({
        "status": "PASS" if not errors else "FAIL",
        "validationScope": "TASK_PACKAGE_FILES_ONLY",
        "projectTestsExecuted": False,
        "postgresqlValidationExecuted": False,
        "checkedFiles": len(expected),
        "errors": errors,
    }, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
