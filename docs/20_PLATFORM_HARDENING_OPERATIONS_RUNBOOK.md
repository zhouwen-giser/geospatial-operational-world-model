# GOWM+ v0.6.1 platform-hardening operations runbook

This runbook qualifies a stable candidate; it does not authorize merge, tag,
release, image publication, or deployment.

## Locked runtime

- PostgreSQL 18, PostGIS 3.6, MobilityDB 1.3, h3-pg/h3_postgis 4.5.0,
  pgRouting 4.0.1.
- Node.js 22 with the checked-in lockfile.
- Migrations 001–057 and SQL assertions 001–042.
- Candidate branch `codex/gowm-platform-hardening-v0.6.1`; PR #6 targets `main`.

## Required sequence

1. Run `npm run check`, `npm run verify:sql`, `npm test`, the STAS suite, and
   `npm run build`.
2. Start a dedicated healthy database container. Never reuse a production or
   shared database.
3. Run `coverage-schema-runtime-gate.mjs`; require fresh, v0.4, v0.5, and seeded v0.6.0 paths,
   57/57 checksum replay, deliberate rollback, and cleanup to pass.
4. Run `coverage-gateway-runtime-gate.mjs`; require real Gateway/DAG/provider/DB
   execution, immutable result publication, and Platform Validation
   CURRENT/STALE/UNKNOWN checks.
5. Run `coverage-security-performance-recovery-gate.mjs`; require scoped reads,
   bounded S/M fixtures, duplicate/cancellation fencing, PostgreSQL restart,
   and deterministic replay.
6. Run `coverage-compatibility-runtime-gate.mjs`; require predecessor locks,
   exact v0.6 Coverage contract bytes, upgrade evidence, and bounded stage
   measurements.
7. Commit all reports, push the candidate, mark PR #6 Ready only when every
   required check passes, then run `gowm-v061-final-candidate.mjs` with the four
   evidence paths. Local HEAD, tracking ref, `ls-remote`, and PR head must match.

## Evidence and restart commands

The retained successful runs use `v061-r2-final`, `v061-r2-gateway`,
`v061-r2-recovery`, and `v061-r2-compat`. Each JSON report records its actual
commands. No credentials from production are needed or permitted.

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
export GOWM_V061_SCHEMA_EVIDENCE=reports/gowm-v0.6.1/d00-runtime-v061-r2-final.json
export GOWM_V061_GATEWAY_EVIDENCE=reports/gowm-v0.6.1/g00-runtime-v061-r2-gateway.json
export GOWM_V061_RECOVERY_EVIDENCE=reports/gowm-v0.6.1/t00-runtime-v061-r2-recovery.json
export GOWM_V061_COMPATIBILITY_EVIDENCE=reports/gowm-v0.6.1/c00-runtime-v061-r2-compat.json
node validation/scripts/gowm-v061-final-candidate.mjs --evidence-only
node validation/scripts/gowm-v061-final-candidate.mjs
```

The full gate validates all 229 explicit case mappings, reruns static gates,
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
- Legacy Coverage records without a compute receipt remain explicitly UNKNOWN
  for compute identity. Do not substitute the problem hash or invent the
  original engine build. New results retain the full standard compute manifest.
- Boundary overlap, invalid geometry, missing versioned Arc identity, scope
  denial, and hash mismatch fail closed.

## Evidence and non-claims

Evidence is written under `reports/gowm-v0.6.1/`. S/M measurements are local
acceptance bounds, not production SLOs. A Coverage plan is not dispatch,
execution authorization, observed completion, safety certification, or
Operational Reality.
