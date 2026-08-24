# Project status

Last updated: 2026-08-24

## Current decision

`GOWM+ 0.4.0-rc.1: BLOCKED_EXTERNAL`

Grounding and Operational Reality are implemented, committed, pushed, and
verified through all runnable C/G/O/S gates. `GROUNDING_READY` and
`OPERATIONAL_REALITY_READY` both pass over real Provider/Gateway HTTP and
PostgreSQL. Final stable promotion is prohibited because Required AC-C007 and
AC-C008 depend on four immutable external inputs that are not available.

## Git delivery

| Item | State |
|---|---|
| Stacked base | `codex/gowm-capability-platform-v0.2` at `99c56b4` |
| Candidate branch | `codex/gowm-grounding-operational-v0.4-stable` |
| Pull request | Draft PR #2 |
| Software version | `0.4.0-rc.1`; stable `0.4.0` withheld |
| Merge/tag/release/deploy | `NOT_RUN`; user-controlled |

Exact local/remote candidate SHA is recorded only in the final report after
the last commit is pushed. The PR must remain Draft while any Required gate is
blocked.

## Phase status

| Phase group | Status | Evidence |
|---|---|---|
| C00–C01 | PASS | source reconciliation and v0.2 report closure |
| C02 | BLOCKED_EXTERNAL | runnable database/H3/Gateway/Spatial/Situation gates pass; exact locked external Provider/DAG inputs absent |
| C03 | PASS | stacked branch and Draft PR created |
| G00–G08 | PASS | contracts through real `GROUNDING_READY` |
| O00–O10 | PASS | immutable events through real `OPERATIONAL_REALITY_READY` |
| S00 | PASS | 33 source-package byte locks and v1 compatibility |
| S01 | PASS | clean, v0.1 upgrade, v0.2 upgrade, rollback, replay |
| S02 | PASS | scope, cursor, redaction, load, late events, projector and database restart |
| S03 | PARTIAL | documentation complete; final `0.4.0` blocked |
| S04 | BLOCKED_EXTERNAL | stable marker and Ready-for-Review forbidden |

## Verified runtime boundary

- PostgreSQL 18.6, PostGIS 3.6.4, MobilityDB 1.3.0, h3/h3_postgis 4.5.0.
- Migrations 001–032 and all 21 SQL assertion suites on clean and upgraded
  databases; migrations 001–014 are byte-locked.
- Four controlled Grounding Providers with 28 capabilities and frozen schema
  hashes.
- Immutable OperationalTask events, independent control/activity/outcome/
  observability state, correlation findings, predicate evaluation, negative
  evidence gating, and replay.
- Typed correlation and predicate DAGs, exact idempotent replay, node/provider
  error identity, cancellation winning a late result, queued-job resume, and
  database restart recovery.
- Cross-scope Reference and Operational reads, signed cursors, public error
  redaction, indexed Reference search, measured timeline/projection gates, and
  concurrent ingest idempotency.

## External blockers

The following exact inputs named by the task package are absent and were not
substituted or reimplemented:

- CRS ZIP SHA-256 `3110e7b344d138908d27e759ede70701b8a20dd7bbbd9795b3a57d02b8d70995`;
- Geometry ZIP SHA-256 `3527a06d7a6216c1bf1c2ee75690824298231917c03a8c99507a71df26f12c3d`;
- Spatial ZIP SHA-256 `15cdaf00f3c5ee911eac1351c2d9a59ff06a5de93a176ce81b644b19ee5de322`;
- H3 Toolkit commit `74fc8657072dd58a2f8e4317c1caef8bfd10e024`.

Consequently the exact locked CRS→Spatial, CRS→Geometry→Spatial, and
CRS→Geometry→H3→Spatial real-runtime DAGs remain unproven.

## Production non-claims

This candidate does not claim a production IdP/authorization deployment,
operating-area CRS/grid certification, HA, production backup/PITR rehearsal,
or production-sized mixed-load/SLO qualification. Local measured gates are
stability evidence, not capacity promises.

## Required next action

Supply the four immutable external inputs, verify their hashes/revision, and
run AC-C007/AC-C008 exactly. If those gates pass, rerun the complete final
matrix, set `VERSION`/root package/changelog to `0.4.0`, push exact SHA parity,
and only then mark Draft PR #2 Ready for Review. Do not merge, tag, release, or
deploy automatically.
