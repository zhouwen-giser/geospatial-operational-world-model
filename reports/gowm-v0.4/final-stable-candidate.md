# GOWM+ 0.4.0 Stable Candidate Report

## Decision

`BLOCKED_EXTERNAL`

All runnable Grounding, Operational Reality, compatibility, migration, scope,
load, and recovery gates pass. Final stable promotion is blocked by two
Required v0.2 closure cases whose exact immutable third-party inputs were not
supplied. The software therefore remains `0.4.0-rc.1` and Draft PR #2 remains
Draft.

## Candidate

- branch: `codex/gowm-grounding-operational-v0.4-stable`;
- stacked base: `codex/gowm-capability-platform-v0.2@99c56b4`;
- reconciled content SHA: `11e022f0fa258e1d67ac985fa80ddb01f6aac102`;
- local and remote content SHA matched exactly at S04 reconciliation;
- PR: `#2`, Draft, merge state clean.

## v0.2 closure

Fresh/upgrade migrations, real PostgreSQL, H3 JS/PG parity, live Gateway,
Spatial/Situation providers, scope attacks, durable idempotency, and restart
recovery pass. AC-C007/AC-C008 remain `BLOCKED_EXTERNAL` because the locked CRS,
Geometry, Spatial POC archives and H3 Toolkit revision are absent. No substitute
was treated as exact evidence.

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
than in-process substitution. The final repository suite passes 117 Vitest
assertions with one declared environment skip, all 39 STAS assertions, SQL AST
checks, type checks, and production builds.

## Performance and recovery

The accepted S02 run measured timeline p95 at `18.967 ms` over 60 reads,
initial projection at `22.540 ms`, and restarted-projector lag at `14.892 ms`.
The scoped Reference plan used
`reference_search_projection_scope_exact_idx`. Concurrent retry produced one
accepted event and seven duplicates. A real PostgreSQL container restart was
followed by successful fresh Reference and Operational repository reads.

These local measurements are stability evidence, not production capacity or
SLO qualification.

## Required matrix

- total Required: 140;
- passed: 136;
- blocked external: AC-C007, AC-C008, AC-S019, AC-S021;
- failed: none;
- undeclared not-run: none.

AC-S019 and AC-S021 are downstream safety blocks: final `0.4.0` and Ready PR
status are forbidden while AC-C007/AC-C008 remain blocked. AC-S024 passes by
emitting the correct blocked marker.

## Known deployment qualifications

Production IdP/authorization, operating-area CRS/grid certification, HA,
backup/PITR rehearsal, and production-sized mixed-load/SLO qualification are
explicit non-claims.

## Explicitly not performed

- merge;
- tag or release;
- production deployment;
- WSGS, SACS, SDAR, SMPP, or A2A changes.

## Unblock procedure

Supply the exact locked CRS/Geometry/Spatial archives and H3 Toolkit commit,
verify their hashes/revision, execute AC-C007/AC-C008, then rerun the complete
matrix. Only a zero-blocked result may promote `VERSION` and the root package to
`0.4.0` and mark PR #2 Ready for Review.

## Final marker

`GOWM_V0_4_STABLE_CANDIDATE_BLOCKED`
