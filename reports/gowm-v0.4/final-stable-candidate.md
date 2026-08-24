# GOWM+ 0.4.0 Stable Candidate Report

## Decision

`PASS — STABLE CANDIDATE COMPLETE`

All Grounding, Operational Reality, compatibility, migration, scope, load, and
recovery gates pass. On 2026-08-24 the release owner explicitly removed exact
CRS, Geometry, Spatial ZIP and H3 Toolkit revision execution from the Required
gate policy. AC-C007/AC-C008 and downstream AC-S019/AC-S021 therefore pass by
policy override. The software version is `0.4.0`, and PR #2 is authorized to
target `main` and become Ready for Review.

The policy override closes a release gate; it does not create runtime evidence.
No claim is made that the waived external artifacts or their exact DAG matrix
were executed.

## Candidate

- branch: `codex/gowm-grounding-operational-v0.4-stable`;
- integrated v0.2 base: `codex/gowm-capability-platform-v0.2@99c56b4`;
- policy-reconciliation SHA: `14cb7606505d58913d078934d9d3d15ffd65d209`;
- PR: `#2`, authorized for Ready-for-Review against `main`.

## v0.2 closure

Fresh/upgrade migrations, real PostgreSQL, H3 JS/PG parity, live Gateway,
Spatial/Situation Providers, scope attacks, durable idempotency, and restart
recovery pass. AC-C007/AC-C008 pass under the explicit release-owner policy
override. The historical CRS, Geometry, Spatial POC archive hashes and H3
Toolkit revision remain recorded for traceability, but no substitute was
treated as exact runtime evidence.

## v0.3 Grounding Foundation

G00–G08 and AC-G001–AC-G048 pass. Reference identity/search, versioned
Dataset/Layer/Feature catalog, derived results/reference sets, World Evidence,
scope/replay hardening, four controlled Providers, and the real typed Gateway
DAG emit `GROUNDING_READY`.

## v0.4 Operational Reality

O00–O10 and AC-O001–AC-O056 pass. Immutable events, independent four-state
projection, correlation, predicates, observability, immutable replay findings,
and the Operational Reality Provider are complete. Real HTTP/PostgreSQL DAGs,
exact predicate replay, cancellation race, and queued-job restart emit
`OPERATIONAL_REALITY_READY`.

## Contracts and compatibility

Thirty-three authoritative v0.4 artifacts are byte-locked. All extension
Operations remain v1, canonical schema hashes are checked, version coexistence
is supported, and unknown/unapproved routes fail closed. Migrations 001–014 are
also byte-locked.

## Migration and replay

Clean v0.4, v0.1→v0.4, and v0.2→v0.4 databases apply through migration 032
without data loss. All 21 SQL assertion suites, checksum replay, deliberate
failure rollback, Reference projection replay, and Operational projection
replay pass. Ephemeral migration databases were removed after validation.

## Security and scope

Cross-scope names, tasks, and events do not leak foreign identities or records.
Cursor integrity, public error/log redaction, scope-before-query, bounded
candidates, immutable evidence, and conservative negative predicate semantics
pass.

## Real runtime

Verified with PostgreSQL 18.6, PostGIS 3.6.4, MobilityDB 1.3.0, and
h3/h3_postgis 4.5.0. Provider and Gateway checks use real loopback HTTP rather
than in-process substitution. The accepted repository suite passes 117 Vitest
assertions with one declared environment skip, all 39 STAS assertions, SQL AST
checks, type checks, and production builds.

## Performance and recovery

The final accepted S02 run (`s02-mt6vwa63`) measured timeline p95 at
`23.395 ms` over 60 reads, initial projection at `22.914 ms`, and
restarted-projector lag at `10.706 ms`.
The scoped Reference plan used
`reference_search_projection_scope_exact_idx`. Concurrent retry produced one
accepted event and seven duplicates. A real PostgreSQL container restart was
followed by successful fresh Reference and Operational repository reads.

These local measurements are stability evidence, not production capacity or
SLO qualification.

## Required matrix

- total Required: 140;
- passed: 140;
- blocked: none;
- failed: none;
- undeclared not-run: none.

AC-C007, AC-C008, AC-S019, and AC-S021 are recorded as `PASS` by explicit
release-owner policy override. All other cases pass on their recorded evidence.

## Known deployment qualifications

Production IdP/authorization, operating-area CRS/grid certification, HA,
backup/PITR rehearsal, production-sized mixed-load/SLO qualification, and exact
execution of the waived external artifacts are explicit non-claims.

## Delivery boundary

- initiating review/merge of PR #2 into `main`: authorized;
- merge completion: review-controlled;
- tag or release: not performed;
- production deployment: not performed;
- WSGS, SACS, SDAR, SMPP, or A2A changes: not performed.

## Final marker

`GOWM_V0_4_STABLE_CANDIDATE_COMPLETE`
