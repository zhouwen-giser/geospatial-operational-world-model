# GOWM+ Network & Basic Routing v0.5 Stable Candidate Report

## Decision

`PASS`

All 154 Required acceptance rows pass with zero failed, blocked, or Required
not-run rows. Optional AC-R027 (distinct alternative signatures) remains
`NOT_RUN_OPTIONAL`; `route.plan-alternatives` remains PREVIEW.

## Candidate and baseline

- Baseline: `main` / `0.4.0` / `db575f79c874a69f65a2043a7e463338524b713d`.
- Stable content candidate: `2ffd012ae421092c0d957877404038ddcf90cdab`.
- Local HEAD, local origin tracking ref, `git ls-remote`, and Draft PR #3 head
  all matched that stable content SHA before this evidence-only report commit.
- Migrations 001–032 remain byte-locked; v0.5 appends through 047.

## Network Foundation and pgRouting runtime

The GOWM+ Data Foundation owns immutable GraphVersions, directed topology,
turn rules, profiles, Condition Snapshots, diagnostics, build receipts,
activation history, and replay. PostgreSQL 18.6, PostGIS 3.6.4, MobilityDB
1.3.0, h3/h3_postgis 4.5.0, and pgRouting 4.0.1 ran together in the candidate
image. The real graph build and pgRouting differential gates passed.

## Network and Route Providers

The 11-operation Network Provider reads only the scoped `gowm_network_v1`
surface. The Route Provider uses that same read authority without Provider
calls or a second graph copy. Real runs prove coordinate/reference endpoints,
joint snap candidates, ordered Waypoints, Via/Avoid Feature, exact PostGIS
Avoid Area, five fixed-point objectives, immutable QueryResult identity, TTL,
cancellation, lease reclaim, and byte-equivalent idempotent replay.

## Independent verifier and Gateway

The verifier imports no solver legality/cost helper and independently replays
identity, continuity, direction, partial fractions, turn legality, metrics, and
freshness. It rejects metric/turn mutation and returns STALE for newer graph or
condition state without rewriting the pinned result. The generic Gateway
passes Direct execution, typed State→Route→Verify DAG, schema fail-closed,
async cancellation, terminal replay, runtime reconstruction, and result
registry integration without routing algorithms or pgRouting SQL.

## Migration, security, performance, and recovery

Fresh 001–047 and v0.4 001–032→047 upgrades pass with 32 SQL assertions,
checksum repeat, data preservation, and failed-migration rollback. Scope and
base-table denial pass. Tokens, locations, coordinates, and route identifiers
are redacted from public errors and audit. After PostgreSQL restart, Network
and Route recovered and exactly one request/result/candidate remained.

S/M acceptance-fixture p95: Snap 11.437 ms, Shortest Path 11.000 ms, bounded
2×2 Matrix 11.002 ms; graph build gate 1465 ms. These are regression budgets,
not production SLOs. DB SPDX and 312-component service CycloneDX SBOMs exist.

## Source, license, and explicit non-claims

The unlicensed reference archive was used only for selective clean-room design
input; expanded source, dependencies, and build artifacts are excluded. This
candidate does not claim regional road coverage, coverage planning, fleet or
multi-vehicle optimization, device dispatch/execution, production IdP/HA/PITR,
operating-area certification, or production-scale SLO/capacity qualification.

## Explicitly not performed

- Merge: `NOT_RUN`
- Tag/release: `NOT_RUN`
- Image publication: `NOT_RUN`
- Production deployment: `NOT_RUN`
- Road coverage planning: `NOT_RUN`
- WSGS/SACS/SDAR/SMPP/A2A changes: `NOT_RUN`

Draft PR #3 is intentionally retained as Draft under the task delivery
instruction. All Required gates are satisfied before any future Ready-for-
Review transition; that transition and all protected actions remain controlled.

## Markers

`NETWORK_READY`

`ROUTING_READY`

`GOWM_NETWORK_ROUTING_V0_5_STABLE_CANDIDATE_COMPLETE`
