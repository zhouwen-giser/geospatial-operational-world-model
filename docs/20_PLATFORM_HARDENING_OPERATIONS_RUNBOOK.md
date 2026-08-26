# GOWM+ v0.6.1 platform-hardening operations runbook

This runbook qualifies a stable candidate; it does not authorize merge, tag,
release, image publication, or deployment.

## Locked runtime

- PostgreSQL 18, PostGIS 3.6, MobilityDB 1.3, h3-pg/h3_postgis 4.5.0,
  pgRouting 4.0.1.
- Node.js 22 with the checked-in lockfile.
- Migrations 001–058 and SQL assertions 001–043.
- Candidate branch `codex/gowm-platform-hardening-v0.6.1`; PR #6 targets `main`.

## Required sequence

1. Run `npm run check`, `npm run verify:sql`, `npm test`, the STAS suite, and
   `npm run build`.
2. Start a dedicated healthy database container. Never reuse a production or
   shared database.
3. Run `coverage-schema-runtime-gate.mjs`; require fresh installation,
   58/58 checksum replay, deliberate rollback, scope/role assertions, and cleanup.
   Historical upgrade paths are supplemental, not required old-data support.
4. Run `coverage-gateway-runtime-gate.mjs`; require real Gateway/DAG/provider/DB
   execution, immutable result publication, and Platform Validation
   CURRENT/STALE/UNKNOWN checks.
5. Run `coverage-security-performance-recovery-gate.mjs`; require scoped reads,
   bounded S/M fixtures, duplicate/cancellation fencing, PostgreSQL restart,
   and deterministic replay.
6. Run `validate:provider-conformance`; require 11 current reports, 70 unique
   protocol operations, exact schema hashes and all contract/unit checks.
   This is not a live H3/STAS/whole-platform readiness claim.
7. Commit all reports, push the candidate, mark PR #6 Ready only when every
   required check passes, then run `gowm-v061-final-candidate.mjs` with the three
   evidence paths. Local HEAD, tracking ref, `ls-remote`, and PR head must match.

## Evidence and restart commands

The current source-locked runs use `v061-locked-d00`, `v061-locked-g00`, and
`v061-locked-t00`. Each JSON records actual commands and matching before/after
source fingerprints. Final acceptance rejects missing fingerprints, changed
source, changed evidence, missing checks or failed checks. Earlier reports are
historical only. No production credentials are needed or permitted.

T00 can reuse a task-owned disposable container only when both
`GOWM_V06_REUSE_DEDICATED_POSTGRES` and `ALLOW_GOWM_DEDICATED_RESTART` exactly
name that container. The script verifies the expected image and that only the
baseline `gowm` and `postgres` databases exist, creates an isolated gate
database, performs a real container restart, then drops only its own database.
Never run D00 or G00 concurrently with T00's restart. The default mode instead
creates and removes a new dedicated container.

Run the evidence preflight before the Ready transition, and the full gate after
the final commit/push:

```bash
export GOWM_V061_SCHEMA_EVIDENCE=reports/gowm-v0.6.1/d00-runtime-v061-locked-d00.json
export GOWM_V061_GATEWAY_EVIDENCE=reports/gowm-v0.6.1/g00-runtime-v061-locked-g00.json
export GOWM_V061_RECOVERY_EVIDENCE=reports/gowm-v0.6.1/t00-runtime-v061-locked-t00.json
node validation/scripts/gowm-v061-final-candidate.mjs --evidence-only
node validation/scripts/gowm-v061-final-candidate.mjs
```

The full gate retains all 229 original case mappings: 227 effective Required
and two SUPERSEDED_BY_USER (AC-R012 and AC-S-03). The preflight proves 224 and
leaves the three delivery cases pending; it does not claim final completion.
The full gate reruns static gates,
rejects changed runtime source/report bytes, and checks local/tracking/remote/PR
SHA equality plus Ready state. Its authoritative final receipt is written to
`/tmp/gowm-v0.6.1-final-acceptance.json`, outside the commit whose SHA it proves.
The PR completion comment persists the same SHA and result. This avoids an
impossible self-referential committed SHA.

## Failure and recovery

- Any failed or missing Required gate keeps the candidate Draft and incomplete.
- Gate databases and dedicated containers use derived, validated names and are
  removed by their owning script. Confirm cleanup before retrying.
- A stale worker generation must never be manually unfenced. Requeue/reclaim
  through the database-authoritative claim API.
- Snapshot `UNKNOWN` is not `CURRENT`; expired results are not usable merely
  because their frozen computation once validated.
- Public Coverage publication requires an actual SNAPSHOT_INTEGRITY receipt,
  separate data/compute identity and a full compute manifest. Missing compute
  authority fails closed; no old-data compatibility fallback is supported.
- Platform Validation is the sole owner of `reference.validate` and
  `result.validate`. Both use the current v0.6.1 batch schema. Do not register
  the removed catalog/evidence validation operations.
- `result.get` uses the current eight-status schema and source semantics.
  `NO_FEASIBLE_PLAN` maps to `NO_FEASIBLE_RESULT`, never to `NO_DATA`.
- Boundary overlap, invalid geometry, missing versioned Arc identity, scope
  denial, and hash mismatch fail closed.

## Evidence and non-claims

Evidence is written under `reports/gowm-v0.6.1/`. S/M measurements are local
acceptance bounds, not production SLOs. A Coverage plan is not dispatch,
execution authorization, observed completion, safety certification, or
Operational Reality.
