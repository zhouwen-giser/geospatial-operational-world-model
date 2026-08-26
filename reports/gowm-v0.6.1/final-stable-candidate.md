# GOWM+ 0.6.1 Stable Candidate Report

## Decision

PASS, bound to the exact candidate commit in the final acceptance receipt.
All 229 Required cases must be PASS, with zero failed, blocked or not-run cases.
The final script independently verifies this report's delivery claims; this
document alone is not the exact-SHA or Ready-state evidence.

## Candidate

- Source: `main@7cd5b133a74b07e28f359176dd13943ab7a6cf54`, version 0.6.0.
- Branch: `codex/gowm-platform-hardening-v0.6.1`, isolated worktree.
- Version: `0.6.1` in VERSION, package.json and package-lock.json.
- PR: [#6](https://github.com/zhouwen-giser/geospatial-operational-world-model/pull/6),
  `fix: harden GOWM road coverage and public platform contracts`, base `main`.
- Runtime correction/evidence commit: `e9954ad`; final documentation is a
  subsequent commit with unchanged runtime source bytes.
- Exact final commit: `candidateContentSha` in the generated
  `/tmp/gowm-v0.6.1-final-acceptance.json` and the PR completion comment. The
  gate requires equality of local HEAD, origin tracking ref, `git ls-remote`
  and PR head, a clean tracked worktree, an OPEN Ready PR, and no incomplete or
  failing PR checks. The receipt is intentionally outside its own commit.

## Road Coverage Correctness

Database-owned attempts/generations are monotonic across expiry, requeue,
concurrent reclaim, cancellation and restart. Old generations cannot heartbeat,
write problem/candidate artifacts or publish results; the new generation
publishes once. Network, Route and Coverage share Network Query Core and read
only scoped versioned Network contracts, without sibling implementation imports
or provider-to-provider HTTP calls.

Boundary facts are independently reconstructed from directed, fraction-aware
Arc geometry and Polygon/MultiPolygon areas. Candidate hints are ignored.
FREE, FIRST_ENTRY_ONLY, ENTRY_SET_ONLY, NO_REENTRY and LAST_AREA_EXIT predicates
are covered by eleven real PostGIS boundary-policy cases. These cases assert
the boundary dimension, while full plan validity/publication is independently
covered by the main Gateway plan/verify E2E. Invalid areas and boundary overlap
fail closed.

Frozen plan validity, current RoutingSnapshot dimensions and result TTL remain
separate. Real graph/profile/cost/condition changes, unknown current condition,
unavailable graph, world advancement, fresh-TTL/stale-snapshot, and
expired-TTL/current-snapshot are tested. INVALID plans do not become merely
STALE when a snapshot advances. Validation never silently replans.

Primary shortest, fastest, lowest-risk and least-deadhead objectives plus four
weighted dimensions are exercised through real Gateway planning and replay.
Fixed-point BigInt arithmetic, overflow rejection, normalization and tie order
have deterministic unit regressions. Generation profiles expand alternatives;
they do not replace the requested primary objective.

Disconnected, turn-blocked, profile-excluded, condition-closed and unreachable
endpoint cases produce domain no-feasible outcomes. Actual database/provider
failures remain failures, not no-feasible results. Legacy generic registry
`NO_DATA` is retained for wire compatibility, original `NO_FEASIBLE_PLAN` is
preserved, and public validation maps it to `NO_FEASIBLE_RESULT`.

Problem, data snapshot and compute snapshot identities are independent. New
compute manifests include solver/verifier/network-core versions, an actual
build digest, policy versions/digests and contract hashes. Legacy records with
missing compute metadata stay explicitly UNKNOWN. Only SERVICE traversal earns
coverage credit; duplicate, transit, access and return evidence does not.
GeoJSON uses scoped versioned Arc-fraction reads and keeps geometry on demand.

## Capability Contract Hardening

`GET /v1/capability-semantics` projects the existing approved Capability Registry,
keyed by operation/version; removal, maturity, schema, typed references,
EXACT/CANDIDATE spatial semantics, negative evidence and deterministic hashes
are tested. It is not a second registry.

Platform Validation normalizes all eight public result statuses, retains source
status, and provides scoped reference/result usability, ordered batches and
audit evidence. Snapshot get/validate checks immutable manifests, hashes,
resource currentness and consistency without mutation or silent upgrades.
Unknown and foreign snapshot lookups have the same opaque error. No WSGS
implementation or black-box client is involved.

## Public Data Foundation Hardening

VECTOR, NETWORK and CURRENT_PROJECTION products are projections of the existing
Dataset/Layer/Feature authority. Real Gateway tests cover current/history,
schema/hash/CRS, bounded extents, lineage, known limitations, validated/unknown
quality, and capabilities derived from approved registry/data bindings.
Kind/spatial/time/capability/quality search, stable filtered pagination,
cursor tampering and scope-before-count are tested. Other product kinds remain
extensible contracts; no mock onboarding or separate readiness claim is made.

Provider conformance passes for all nine required public providers. Aggregate
hash: `sha256:7ce2f4b58f74b0b725f4720dc96db4f00b590e297978704097ba70313abe07ad`.

## Contracts and compatibility

All 53 baseline migrations and 103 v0.4/v0.5/v0.6 contract artifacts match actual
R00 main bytes. The 19 Coverage schemas, Provider Manifest and OpenAPI remain
byte-frozen. v0.6.1 schemas and operations are additive; no incompatible schema
is silently substituted under an existing operation version.

Task package validation: 21 schemas, 10 semantic profiles, 10 examples and
229 acceptance rows PASS. Repository contract generation/type checks, SQL AST,
build and conformance PASS. Vitest: 264 passed, zero failed, one default external
database test skipped; the Required database proof is the real D00 gate, not
that skip. STAS: 14 files passed.

## Migrations/replay

[D00](d00-runtime-v061-r2-final.json) passes 57 migrations and 42 assertion suites,
fresh install and v0.4/v0.5/v0.6.0 upgrade paths, four 57-entry checksum replays,
deliberate transaction rollback and cleanup. The seeded v0.6.0 upgrade preserves
3 datasets, 1 graph version, 7 arcs and 1 activation event. Assertions 039–042
run on that populated upgrade; all 42 suites also run on the clean paths.
[C00](c00-runtime-v061-r2-compat.json) validates compatibility and restart replay.

## Security/scope

Least-privilege readonly contracts, parameterized SQL, bounded geometry/query
limits, opaque cross-scope result/snapshot/catalog behavior, cursor tampering,
log redaction, provider isolation and cancellation fencing all PASS. No
production/shared database was used. The original user worktree was preserved.

## Real runtime and recovery

| Gate | Current evidence |
|---|---|
| D00 | PASS; 57 migrations / 42 assertion suites / four paths |
| [G00](g00-runtime-v061-r2-gateway.json) | PASS; 150 checks through real Gateway/providers/PostGIS |
| [T00](t00-runtime-v061-r2-recovery.json) | PASS; 72 before / 5 after real PostgreSQL restart |
| C00 | PASS; immutable predecessor bytes, migration/replay and bounded workloads |

The locked Docker stack is PostgreSQL 18, PostGIS 3.6, MobilityDB 1.3,
h3-pg/h3_postgis 4.5.0 and pgRouting 4.0.1. Gate databases were removed by their
own cleanup paths. T00 used explicitly authorized dedicated-container reuse
and verified no foreign databases before restarting it. Failed attempts and
their corrections are retained in the ExecPlan; none is counted as a pass.

[runtime-source-lock.json](runtime-source-lock.json) records the post-runtime
freeze of 811 implementation/runtime files and the four successful reports.
The final gate rejects any changed bytes or file-set drift. Per-case named
runtime checks and actually passed unit tests are validated from
[case-evidence.json](../../validation/gowm-v0.6.1/case-evidence.json), rather than
inferring each case from an area-wide PASS.

## Performance evidence

| Local acceptance workload | Observed | Bound |
|---|---:|---:|
| Small Coverage, 1 obligation | 283.717 ms | 10,000 ms |
| Medium Coverage, 20 obligations / 40 segments | 734.029 ms | 30,000 ms |
| Small / medium heap delta | 5,304,960 / 10,058,368 bytes | 134,217,728 bytes each |
| Boundary read | 7.218 ms | 10,000 ms |
| Scoped catalog search | 48.995 ms | 30,000 ms |
| Semantic projection | 32.260 ms | 5,000 ms |

Lease reclaim load also passed its 10-second bound. These are local acceptance
measurements, not production SLOs or a cross-workload speedup claim.

## Known deployment qualifications

Single-route, fixed-direction strict Coverage scope remains unchanged; unsupported
fleet/capacity/time-window/either-direction requests fail closed. A plan is not
dispatch authority, device instruction, physical completion or a safety claim.
UNKNOWN quality/currentness is not upgraded to validated/current. The legacy
single-scope H3 Situation limitation remains documented. Deployment needs its
own data onboarding, production sizing, credentials, backups and authorization.

## Explicitly not performed

- WSGS implementation or readiness black-box.
- Data Platform Readiness gate or mock ELEVATION onboarding.
- SACS/SDAR/A2A changes.
- Merge, tag/release, image publication or production deployment.

## Markers

Emitted only when the final exact-SHA/Ready acceptance gate succeeds:

```text
ROAD_COVERAGE_CORRECT
CAPABILITY_CONTRACTS_HARDENED
PUBLIC_DATA_FOUNDATION_HARDENED
GOWM_V0_6_1_STABLE_CANDIDATE_COMPLETE
```
