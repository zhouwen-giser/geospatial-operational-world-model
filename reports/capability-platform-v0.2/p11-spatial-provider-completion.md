# P11 Spatial Provider Bridge

Status: **implementation PASS; phase PARTIAL**

## Outcome

The GOWM-owned Spatial Provider Bridge implements all ten formal operations.
The first eight are `PREVIEW`; `spatial.join` and `spatial.aggregate` remain
`EXPERIMENTAL`. It is an independent reimplementation informed by the locked
Apache-2.0 Spatial POC contract and never copies or runs its source in GOWM.

Every data execution uses a dedicated pool and a `REPEATABLE READ READ ONLY`
transaction, applies transaction-local statement/lock timeouts, establishes the
trusted DataScope through `gowm_spatial_v1.set_data_scope`, reads a current
dataset descriptor, and executes static parameterized PostGIS SQL against only
`gowm_spatial_v1`. There are no provider-to-provider calls, caller URLs, table
names, dynamic SQL, or base-table reads.

Results expose opaque `ReferenceKey` values plus freshness, confidence,
provenance, World Evidence, `CONSISTENT_AT_START` Data Snapshots, Compute
Snapshots, and canonical Execution Receipts. Signed keyset cursors are bound to
operation, scope digest, snapshot version, sort semantics, and opaque ID.
`find-nearby` and `find-nearest` accept both the canonical location object and
the canonical CRS point position array `[longitude, latitude, z?]`. The exact
verification operations `find-in-area` and `find-intersections` accept at most
50,000 opaque candidate `ReferenceKey` values, apply them only through a JSONB
parameterized prefilter, and still require the exact PostGIS predicate.

## Key artifacts

- `contracts/capabilities/spatial-provider/operations.schema.json`
- `contracts/manifests/providers/spatial-provider.json`
- `contracts/manifests/providers/spatial-provider-source-lock.json`
- `services/providers/spatial-provider-bridge/`
- `validation/provider-conformance/spatial/`
- `reports/capability-platform-v0.2/p11-spatial-provider-acceptance.json`

The source lock retains ZIP/OpenAPI/contract hashes, Apache-2.0 attribution,
NOTICE, and CycloneDX SBOM. Expanded POC source is ignored and untracked.

## Tests actually run

| Command | Result | Evidence |
|---|---|---|
| Spatial Provider conformance | PASS | 1 file, 10 tests, 0 failures |
| Spatial static architecture | PASS | `SPATIAL_ARCHITECTURE_PASS` |
| Generated contract drift check | PASS | deterministic output current |
| Gateway contract suite | PASS | 15/15 |
| Root strict typecheck | PASS | TypeScript and STAS |
| Global capability boundaries | PASS | `CAPABILITY_BOUNDARIES_PASS` |
| Intake tracked/ignored check | PASS | expanded source ignored/untracked |
| Real PostgreSQL semantics | NOT_RUN | no DB URL; Docker API denied |
| EXPLAIN index plans | NOT_RUN | same runtime blocker |
| Mixed load | NOT_RUN | same runtime blocker |

The scoped tests cover all operation routes, strict schemas, Provider SDK
conformance, HTTP routing, scope enforcement order, read-only transactions,
timeouts, opaque output/evidence, snapshot honesty, receipts, cursor binding,
candidate budgets, PostGIS engine-version readiness attestation, generic denial
mapping, and the required PostGIS predicate choices.

## Acceptance status

AC-062 through AC-066 are **PARTIAL**: their static SQL and protocol-faithful
Provider paths pass, but the acceptance matrix explicitly requires real
PostgreSQL evidence. AC-067 and AC-068 are **NOT_RUN** because there is no live
EXPLAIN or mixed-load evidence. No benchmark or production SLO claim is made.

## Runtime blocker

`TEST_DATABASE_URL`, `DATABASE_URL`, and `SPATIAL_DATABASE_URL` were all absent.
A non-mutating Docker API probe was permission denied in the current sandbox.
Following the parent task constraint, no new Docker escalation was requested.
Closing P11 requires a permitted PostgreSQL run of database assertion 003,
real operation fixtures, EXPLAIN plans, and the declared mixed-load profile.

No migration was created or renumbered; P11 consumes migration 012. Migration
013 remains reserved for P12 World Query persistence.

No commit, push, or PR action was performed in this delegated slice.
