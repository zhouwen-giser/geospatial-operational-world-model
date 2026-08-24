# Project status

Last updated: 2026-08-24

## Current decision

`GOWM+ 0.4.0: STABLE CANDIDATE COMPLETE`

Grounding and Operational Reality are implemented and verified through all
runnable C/G/O/S gates. `GROUNDING_READY` and `OPERATIONAL_REALITY_READY` both
pass over real Provider/Gateway HTTP and PostgreSQL. The release owner removed
the exact external-artifact execution requirement from AC-C007/AC-C008; those
cases and downstream AC-S019/AC-S021 pass by explicit policy override. This
does not represent runtime evidence for the waived artifacts.

## Git delivery

| Item | State |
|---|---|
| Stacked base | `codex/gowm-capability-platform-v0.2` at `99c56b4` |
| Candidate branch | `codex/gowm-grounding-operational-v0.4-stable` |
| Pull request | PR #2; Ready for Review against `main`; merge state `CLEAN` |
| Software version | `0.4.0` |
| Merge | initiation authorized; completion remains review-controlled |
| Tag/release/deploy | `NOT_RUN`; separately controlled |

Stable content SHA `0d0d4d2e5a3c1b958fc6c7f138dbc20257b89696` matched locally and remotely at
delivery reconciliation. The final documentation-only reconciliation HEAD is
reported in the handoff after push.

## Phase status

| Phase group | Status | Evidence |
|---|---|---|
| C00–C01 | PASS | source reconciliation and v0.2 report closure |
| C02 | PASS | runnable database/H3/Gateway/Spatial/Situation gates pass; AC-C007/C008 pass by explicit policy override |
| C03 | PASS | stacked branch and Draft PR created |
| G00–G08 | PASS | contracts through real `GROUNDING_READY` |
| O00–O10 | PASS | immutable events through real `OPERATIONAL_REALITY_READY` |
| S00 | PASS | 33 source-package byte locks and v1 compatibility |
| S01 | PASS | clean, v0.1 upgrade, v0.2 upgrade, rollback, replay |
| S02 | PASS | scope, cursor, redaction, load, late events, projector and database restart |
| S03 | PASS | documentation and version promoted to `0.4.0` |
| S04 | PASS | 140/140 Required cases pass; stable marker complete |

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

## Waived external verification

The following exact inputs named by the task package were not supplied or
executed, and were not substituted or reimplemented:

- CRS ZIP SHA-256 `3110e7b344d138908d27e759ede70701b8a20dd7bbbd9795b3a57d02b8d70995`;
- Geometry ZIP SHA-256 `3527a06d7a6216c1bf1c2ee75690824298231917c03a8c99507a71df26f12c3d`;
- Spatial ZIP SHA-256 `15cdaf00f3c5ee911eac1351c2d9a59ff06a5de93a176ce81b644b19ee5de322`;
- H3 Toolkit commit `74fc8657072dd58a2f8e4317c1caef8bfd10e024`.

The release owner explicitly canceled these inputs as Required gates. The exact
locked CRS→Spatial, CRS→Geometry→Spatial, and CRS→Geometry→H3→Spatial
real-runtime DAGs therefore remain non-claims rather than blockers.

## Production non-claims

This candidate does not claim a production IdP/authorization deployment,
operating-area CRS/grid certification, HA, production backup/PITR rehearsal,
or production-sized mixed-load/SLO qualification. Local measured gates are
stability evidence, not capacity promises.

## Delivery action

Review and, when approved, merge PR #2 into `main`. Tag, release, and production
deployment remain separate user-controlled actions.
