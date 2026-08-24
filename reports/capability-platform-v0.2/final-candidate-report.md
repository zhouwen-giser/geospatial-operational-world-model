# GOWM+ Capability Platform v0.2 Final Candidate Report

## Decision

`BLOCKED`

The architecture and controlled implementation evidence are substantial, and
the implementation is committed and pushed. Required real-runtime acceptance
is incomplete, so this is not yet a final candidate. No fixture, static SQL parse, controlled
in-process Provider runtime, or prior v0.1 database run is presented as the
missing v0.2 real-runtime proof.

## Candidate

| Item | Value |
|---|---|
| Base | `d1ff3b81b8bf577965b00edc1bd06acaaeda706c` |
| Branch | `codex/gowm-capability-platform-v0.2` |
| SHA containing v0.2 implementation | `1887e56a18b77aa9692cca9d86b00413906816f4` |
| C00 reconciled local/remote SHA | `80f10718fc2cdeeb9c915bdb49c499d1930eb9a3` |
| Pull request | [Draft PR #1](https://github.com/zhouwen-giser/geospatial-operational-world-model/pull/1) |

AC-095 is now `PASS`: the full implementation is represented by a matching
committed and pushed SHA. Required live-runtime gates remain independent.

## Architecture outcome

The implementation establishes three explicit planes:

- the Data Foundation remains authoritative for canonical facts, immutable
  evidence inputs, current projection, TrackletVersions, and versioned read
  contracts;
- independently deployable Providers execute declared capability operations
  without calling one another or writing Foundation facts;
- the World Capability Gateway owns controlled registration, trusted
  identity/scope, version/schema resolution, budgets, routing, idempotency,
  typed DAG/job orchestration, receipts, and audit while containing no GIS or
  STAS domain engine.

Foundation ingest/projection uses local CRS/Geometry/H3 ports and does not
synchronously depend on the Gateway. Receipt/Evidence and Data/Compute Snapshot
semantics are separated. H3 remains candidate/coarse; Spatial/PostGIS owns exact
topology. Spatial reads only the scope-filtered `gowm_spatial_v1` contract.

## Provider integrations

The controlled Registry binds six Provider identities and 50 versioned
operations: CRS (6), Geometry (19), H3 interactive (8), H3 analysis (3), GOWM
H3 Situation (4), and Spatial (10). All are PREVIEW except Spatial join and
aggregate, which are EXPERIMENTAL. `elevation.sample.mock` demonstrates
extension without operation-specific Gateway core code and is not a production
capability.

Bridge, contract, source-lock, conformance, policy, and controlled in-process
evidence exists. The required real locked CRS, Geometry, and H3 processes plus
real PostgreSQL-backed Spatial/Situation execution through the Gateway were not
completed in one acceptance environment.

## Foundation isolation

Projection code uses canonical EPSG:4326 local normalization, immutable local
Geometry validation, and transaction-local h3-pg. A controlled invalid-geometry
case rolls back before current-state mutation. Live database receipt insertion,
live h3-pg parity, and the complete remote-outage fault scenario remain
incomplete and are not promoted to real evidence.

## Database and migrations

Migrations `001`-`010` remain immutable. Append-only migrations `011`-`014`
define Gateway persistence, `gowm_spatial_v1` and opaque ReferenceKeys,
Foundation processing receipts, World Query persistence/leases, and separate
least-privilege service roles. Static SQL verification is not equivalent to the
required fresh install, v0.1 upgrade, live privilege/scope assertions, or
restart recovery; those remain `NOT_RUN/BLOCKED` for v0.2.

## Required acceptance summary

- Controlled contract, unit, conformance, boundary, security, compatibility,
  and DAG evidence: present in P01-P15 phase reports.
- Required real database, Provider, container, exact cross-capability, scope,
  restart, and performance evidence: incomplete; see the P16 report.
- Capability catalog and known-limit documentation (AC-093/094): PASS.
- Exact committed/pushed implementation SHA (AC-095): PASS.
- PR Ready-for-Review (AC-096): BLOCKED on required live-runtime gates.

No aggregate PASS count is claimed before the root final gates and evidence
consolidation complete.

## Real runtime evidence

P00 proved the prior ten-migration GOWM/STAS baseline on PostgreSQL 18.4,
PostGIS 3.6.4, MobilityDB 1.3.0, and H3 4.5.0. That earlier baseline does not
prove the new v0.2 migrations or Provider/Gateway runtime.

The current session could reach an isolated PostgreSQL port, but available
credentials were rejected with SQLSTATE `28P01`. Docker execution/provisioning
and the locked external Provider chain were unavailable. Therefore the v0.2
fresh/upgrade database, container health/readiness/non-root, real Provider,
H3 JS/PG parity, exact DAG, cross-scope, restart, and mixed-load gates remain
`NOT_RUN` or `BLOCKED`.

## Supply-chain and license boundaries

- Input ZIP hashes and the H3 commit lock were verified at P00.
- Expanded external source and uploaded ZIPs remain outside tracked/release
  artifacts.
- CRS and Geometry project-level licenses are unspecified. Their upstream
  source, packages, and images must not be published by GOWM+.
- H3 Toolkit and Spatial Apache-2.0 Notice and SBOM material is retained.
- No release package was built or published.

## Known limitations

- Shared bearer-token integration is not a production identity provider.
- Operating-area CRS/grid certification and real CRS attestation are missing.
- Real Geometry worker timeout/overload recovery is unproven.
- Real H3 API/PG parity and exact H3-to-Spatial verification are unproven.
- Real Spatial correctness, scope denial, index plan, and mixed-load behavior is
  unproven.
- Real Gateway/Provider/database restart and idempotent recovery is unproven.
- The current Situation projection supports only a pinned single-scope safety
  model; arbitrary multi-scope serving remains blocked.
- HA, backup/PITR rehearsal, and target production SLO qualification are not
  complete.
- The v0.2 work has a committed/pushed implementation SHA; live qualification
  remains incomplete.

## Explicitly not performed

- merge
- tag or release
- production deployment
- Ready-for-Review transition
- publication of CRS/Geometry upstream artifacts

## Final marker

`GOWM_CAPABILITY_PLATFORM_V0_2_GOAL_BLOCKED`
