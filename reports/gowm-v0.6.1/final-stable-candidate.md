# GOWM+ 0.6.1 Stable Candidate Report

## Decision and scope

Implementation evidence PASS; final delivery is exact-commit receipt-bound.
The previous completion for `5029bce` is withdrawn and is not reused.

The original matrix retains 229 rows. The user's no-old-data/current-design
instruction supersedes AC-R012 (old wire compatibility) and AC-S-03 (old-data
upgrade). The effective Required count is 227, not 229. Preflight verifies
224 PASS and leaves AC-S-22/23/24 pending final Git/Ready/marker checks.
Superseded requirements are never counted as PASS.

The final receipt must report 227 PASS, two SUPERSEDED_BY_USER, zero
failed/blocked/not-run and the exact current commit. The committed sync/phase
reports intentionally await that receipt; no file can contain its own commit hash.

## Candidate and delivery proof

- Source: `main@7cd5b133a74b07e28f359176dd13943ab7a6cf54`, version 0.6.0.
- Branch: `codex/gowm-platform-hardening-v0.6.1`, isolated worktree.
- Version: 0.6.1 across VERSION/package/lockfile.
- [PR #6](https://github.com/zhouwen-giser/geospatial-operational-world-model/pull/6):
  `fix: harden GOWM road coverage and public platform contracts`, base main.
- Final authority: `candidateContentSha` in
  `/tmp/gowm-v0.6.1-final-acceptance.json` and the PR completion comment.
- The final command requires exact local/tracking/ls-remote/PR SHA equality,
  clean tracked content, OPEN Ready state and no incomplete/failing PR checks.

## Corrected audit findings

| Finding | Current implementation and executed evidence |
|---|---|
| Duplicate validation owner | Only Platform Validation registers reference.validate/result.validate; same current batch contract; all current providers co-register successfully |
| Stale query falsely CURRENT/YES | Scoped read-only repeatable-read authority checks actual current graph, dataset, profile, cost, condition and world versions; retired/expired/unknown records fail closed |
| In-memory authority inside a real gate | G00 now runs actual PostgreSQL-backed Validation, World Evidence, Route and Coverage providers, including currentness mutation and sibling-dataset isolation |
| Fail-open conformance | Actual runtime manifests, known schema resolution, exact hashes, all-operation forged-hash rejection, AST import checks and deterministic reports; contract/unit evidence is labelled, not called live readiness |

Current public result.get uses all eight normalized statuses and retains source
status/authority. NO_FEASIBLE_PLAN maps to NO_FEASIBLE_RESULT, not NO_DATA.
Public Coverage result registration requires a real SNAPSHOT_INTEGRITY receipt
and separate data/compute hashes; no fabricated legacy compute identity remains
on the current publication path. Optional World Evidence date fields are omitted
rather than hashed as undefined; the real geometry route has a typed output port.

## Road Coverage correctness

Attempts and generations are database-allocated, monotonic and fenced across
expiry, requeue, concurrent reclaim, cancellation and real restart. Old workers
cannot heartbeat, persist artifacts or publish; a new generation publishes once.

Network, Route and Coverage consume the shared Network Query Core through
scoped versioned SQL APIs. Candidate boundary events are hints; the verifier
reconstructs crossings from actual directed Arc geometry and Polygon/MultiPolygon
areas. Invalid geometry/overlap and unsupported routing policies fail closed.

Frozen validity, snapshot currentness, result TTL and source execution status
stay separate. G00 publishes actual Route/Coverage plans, advances actual graph
and profile/condition/world authority, and verifies stale/non-usable results.
It exercises missing snapshots, retirement, all reference kinds, source status,
ordered batches, dataset isolation and real authority-unavailable errors.
Validation does not silently replan or turn UNKNOWN into CURRENT.

Fixed-point primary objectives, deterministic alternatives, independent verifier
replay, service-only coverage credit and on-demand GeoJSON remain covered.
A no-feasible domain result never hides a database/provider failure.

## Capability contracts and Public Data Foundation

Capability semantics are deterministic projections of the approved Registry,
not a second registry. Platform Validation reads existing authorities and an
immutable snapshot registry, not a new fact store.

VECTOR, NETWORK and CURRENT_PROJECTION products derive from existing
Dataset/Layer/Feature authority. Scope-before-count, search, versions, schema,
CRS, bounded extents, lineage, quality, registry-derived capabilities and
tamper-resistant pagination are exercised through the real Gateway.

Conformance produces 11 reports (the nine required domains plus H3 interactive
and Platform Validation), with 70 unique protocol operations. STAS is checked
through its actual 15-tool native registry, executable schema/OpenAPI locks and
40 native tests, not a fabricated Provider Protocol manifest. Protocol and
native contract/unit checks do not assert live upstream readiness.

## Executed acceptance

| Gate | Current result |
|---|---|
| [D00](d00-runtime-v061-locked-d00.json) | PASS: 58 migrations / 43 assertion suites; fresh install, rollback, checksum replay, least privilege and scope; historical upgrades supplemental |
| [G00](g00-runtime-v061-locked-g00.json) | PASS: 160 real Gateway/Provider/PostgreSQL checks |
| [T00](t00-runtime-v061-locked-t00.json) | PASS: 72 before / 5 after real dedicated PostgreSQL restart |
| [Static regression](static-regression.json) | PASS: 288 Vitest, 40 STAS, schema/type/SQL/build |
| [Conformance](provider-conformance/aggregate.json) | PASS: 11 reports, 70 protocol operations; contract/unit evidence |
| Per-case preflight | 224 PASS; 3 delivery pending; 2 superseded |

The one skipped default external-DB Vitest test is covered by actual D00; no
Required database case relies on that skip. Migrations 001–053 and retained
historical contract artifacts still match the R00 source byte lock.

The three Docker gates and conformance independently captured identical
before/after source fingerprint
`e36a2c67eda8c6d6104ecf67b4de917d118ca31fb53bc009a0a9f20fa3d5bcda`.
[runtime-source-lock.json](runtime-source-lock.json) binds 947 source files and
the successful evidence bytes. Named per-case checks, passed unit files and
per-provider report hashes are verified by the final command; an area-wide PASS
alone is insufficient.

The task-owned Docker stack is PostgreSQL 18, PostGIS 3.6, MobilityDB 1.3,
h3-pg/h3_postgis 4.5.0 and pgRouting 4.0.1. Only isolated gate databases were
created and removed. T00 checked the dedicated container boundary before
restart. The existing container/volume were retained; original user work was preserved.

## Bounded fixture performance

| Measurement | Observed | Bound |
|---|---:|---:|
| Small Coverage, one obligation | 569.019 ms | 10,000 ms |
| Medium Coverage, 20 obligations / 40 segments | 1,401.335 ms | 30,000 ms |
| Small / medium heap delta | 5,329,328 / 23,073,024 bytes | 134,217,728 bytes each |
| Boundary read | 8.303 ms | 10,000 ms |
| Scoped catalog search | 37.991 ms | 30,000 ms |
| Semantic projection | 8.654 ms | 5,000 ms |
| Lease reclaim load | 1,213.378 ms | 10,000 ms |

These are local acceptance measurements, not production SLOs, capacity claims,
or comparisons against a previous runtime.

## Exclusions and historical evidence

Earlier `v061-r2-*`, `v061-authority-*` and `v061-current-*` reports are
historical attempts, including failures; only the source-locked reports above
certify this implementation. See the ExecPlan for corrections and failures.

No WSGS readiness/client, separate Data Platform Readiness, mock ELEVATION
onboarding, SACS/SDAR/A2A changes, merge, tag, release, image publication or
deployment was performed. Single-route strict Coverage remains non-dispatchable:
it is not execution authorization, observed completion, safety certification or
Operational Reality. Production credentials, onboarding, sizing, HA and backups
remain deployment responsibilities.

## Final markers

Emitted only after the final exact-SHA/Ready receipt succeeds:

```text
ROAD_COVERAGE_CORRECT
CAPABILITY_CONTRACTS_HARDENED
PUBLIC_DATA_FOUNDATION_HARDENED
GOWM_V0_6_1_STABLE_CANDIDATE_COMPLETE
```
