# Geospatial Operational World Model Plus (GOWM+)

GOWM+ combines an authoritative geospatial data foundation with an extensible
Capability Service Plane and a controlled World Capability Gateway.
Version `0.7.0` adds runtime-discovered effective snapshots, immutable task
execution intervals, generation-fenced Tracklet finalization, and pinned
historical trajectory reconstruction with explicit lineage and gaps. The new
historical operations remain Preview. It retains the v0.6.4 Reference
Composability Repair, so resolver-issued immutable references compose directly
with current validation, geometry, state, and spatial reads. Execution Protocol
remains 1.0, and the existing Foundation, GIS, H3, STAS, routing and coverage
authorities remain unchanged.

Use the [World Platform guide](docs/architecture/WORLD_PLATFORM_GATEWAY_V0.6.2.md)
for the single consumer endpoint, isolated Compose profile, exact/candidate
semantics, runtime qualifications and acceptance commands. Completion is bound
to fresh machine evidence and exact source identity; historical reports are not
evidence for this candidate. No merge to `main`, tag, release, or production
deployment is performed by these qualification steps.

See the [v0.6.3 Grounding Core guide](docs/architecture/GROUNDING_CORE_V0.6.3.md)
for the promoted operations and consumer contracts, and the
[operator runbook](docs/21_GROUNDING_CORE_OPERATIONS_RUNBOOK.md) for identity,
snapshot, availability, and rollback procedures.

See [PROJECT_STATUS.md](PROJECT_STATUS.md) for the exact delivery boundary and
[the v0.2 architecture](docs/architecture/CAPABILITY_PLATFORM_V0.2.md) for the
trust and ownership model.

## Architecture

| Plane | Responsibility | Prohibited responsibility |
|---|---|---|
| Data Foundation | Canonical observations, time, measurements, current projection, immutable TrackletVersions, Network GraphVersions, `gowm_spatial_v1`, `gowm_network_v1`, and local processing receipts | Synchronous dependency on the Gateway or remote Providers |
| Capability Service Plane | Versioned CRS, Geometry, H3, Situation, Spatial, and application Provider operations | Provider-to-Provider calls or canonical Foundation writes |
| World Capability Gateway | Trusted identity/scope, controlled registry, schema/version policy, budgets, routing, idempotency, typed DAGs, jobs, receipts, and audit | PROJ, GEOS, H3, PostGIS, MobilityDB, STAS algorithms, arbitrary SQL/URLs, or dynamic tool discovery |

The public execute body cannot supply identity, DataScope, DatasetScope, or a
Provider URL. Deployment-owned configuration selects an approved Provider, the
Gateway creates a bounded internal attestation, and the Provider validates the
request and scope again.

Planning, control, and operational reality are separate authorities. External
planning identifiers, correlation hints, predicates, and Provider-declared
actions are immutable claims or evaluation inputs—not World Facts. Control
completion reports affect only the control dimension; physical verification
requires independent evidence. Correlation/evaluation never mutates the
external planner or controller.

Foundation projection uses local ports for canonical EPSG:4326 validation and
normalization plus transaction-local h3-pg computation. A Gateway or remote
Provider outage is therefore not a fallback condition on the ingest/projection
critical path.

## Capability catalog

The original computation/spatial manifest group defines the following
operations. The current catalog/validation/network/coverage groups are listed
below it. All versions below are `1.0`; `PREVIEW` is the default maturity unless noted.

| Provider | Operations | Maturity |
|---|---|---|
| CRS normalization | `crs.check-source`, `crs.normalize.point`, `crs.normalize.points`, `crs.normalize.geometry`, `crs.normalize.feature`, `crs.normalize.feature-collection` | PREVIEW |
| Geometry | `geometry.validate`, `geometry.normalize`, `geometry.force-2d`, `geometry.remove-repeated-points`, `geometry.centroid`, `geometry.bounding-box`, `geometry.geometry-hash`, `geometry.predicate`, `geometry.make-valid`, `geometry.buffer`, `geometry.intersection`, `geometry.union`, `geometry.difference`, `geometry.symmetric-difference`, `geometry.simplify`, `geometry.simplify-preserve-topology`, `geometry.convex-hull`, `geometry.closest-point`, `geometry.shortest-line` | PREVIEW |
| H3 interactive | `h3.index.points`, `h3.geometry.cover`, `h3.cells.to-geojson`, `h3.neighborhood.disk`, `h3.hierarchy.parent`, `h3.hierarchy.children`, `h3.hierarchy.compact`, `h3.hierarchy.uncompact` | PREVIEW |
| H3 analysis | `h3.analytics.aggregate`, `h3.analytics.coverage`, `h3.analytics.flow` | PREVIEW |
| GOWM H3 Situation | `gowm.situation.h3.get-cell`, `gowm.situation.h3.get-area`, `gowm.situation.h3.get-hotspots`, `gowm.situation.h3.get-coverage-gaps` | PREVIEW |
| Spatial Analysis | `spatial.find-nearby`, `spatial.find-nearest`, `spatial.find-in-area`, `spatial.find-intersections`, `spatial.find-near-route`, `spatial.find-containing-area`, `spatial.count-in-area`, `spatial.summarize-area` | PREVIEW |
| Spatial Analysis | `spatial.join`, `spatial.aggregate` | EXPERIMENTAL |

`elevation.sample.mock` is a conformance sample, not a production capability.
It demonstrates that a new manifest and Provider can register, execute directly,
and participate in a DAG without operation-specific Gateway code.

H3 cover and Situation lookup are candidate/coarse operations. They never
replace exact boundary decisions; boundary-sensitive results must be verified
by the Spatial Provider/PostGIS.

The Grounding registry has independently controlled Reference (4 operations),
Dataset Catalog (13), World Evidence (8), Platform Validation (4), and
Operational Reality (8) providers. They expose Reference resolution/search,
Dataset/Layer/Feature and Data Product catalog access, World Evidence/result/
reference-set reads, unified validation, and eight
Operational Reality operations for tasks, timelines, correlation, predicates,
and observability. Historical schemas remain under `contracts/gowm-v0.4`;
current validation and query-result semantics use `contracts/gowm-v0.6.1`.

The v0.5 Network catalog adds 11 stable read operations for graph lookup,
diagnostics, directed snapping, shortest path, bounded cost matrix, path
verification/expansion, connectivity, and reachability. The Route Planning
Provider adds stable validation/planning/verification plus PREVIEW alternatives.
Routes pin dataset, graph, profile, cost, and condition identity; candidate
metrics use fixed-point integers and are replayed by an independent verifier.

The v0.6 Road Coverage Provider adds five stable operations:
`coverage.road.validate`, `coverage.road.select-obligations`,
`coverage.road.plan`, `coverage.road.verify`, and
`coverage.road.expand-geojson`. It plans one route over a pinned RoutingSnapshot,
keeps required service obligations R separate from the full traversable network
E, verifies every admitted candidate independently, and expands geometry only
on demand. The Gateway remains the only public asynchronous Job authority.

The v0.6.1 platform additions expose deterministic registry semantics at
`/v1/capability-semantics`, expose `reference.validate`, `result.validate`, `snapshot.get`, and
`snapshot.validate` through the independently deployable Platform Validation
Provider, and extend the Grounding catalog with scoped Data Product search,
versions, schema, lineage, quality, and supported-capability reads. These are
read-only projections, not new fact or registry authorities.

## Contracts and execution

JSON Schemas under `contracts/platform` and `contracts/capabilities` are the
normative source for generated TypeScript and runtime validation. The Gateway
exposes:

```text
GET  /v1/capabilities
GET  /v1/capabilities/{operationId}
POST /v1/operations/{operationId}:execute
POST /v1/world-queries
GET  /v1/world-queries/{queryId}
POST /v1/world-queries/{queryId}:cancel
GET  /v1/jobs/{jobId}
GET  /v1/receipts/{receiptId}
```

World Query v2 validates the full DAG before Provider work: operation/version
and schema locks, acyclicity, typed ports, bounded nested bindings, scope and
snapshot policy, and aggregate budgets. It supports synchronous and asynchronous
jobs, cancellation, fail-fast/partial behavior, and durable node hashes.

Every completed operation has a Compute Snapshot and an Execution Receipt. A
receipt describes a method applied to an input; it is not World Evidence.
Only data-bound operations may return a Data Snapshot and Evidence References.

## Database and ownership

The PostgreSQL 18 baseline includes PostGIS 3.6, MobilityDB 1.3, h3-pg /
h3_postgis 4.5, and pgRouting 4.0.1. Migrations `001`-`032` remain the locked
v0.4 baseline; append-only migrations through `047` add Network/Route authority
and migrations `048`-`053` add the private, derived `coverage_planner` runtime.
Append-only migrations `054`-`058` add generation fencing, authoritative
boundary reads, immutable Coverage artifact reads, and the Platform Validation
snapshot registry, reference lifecycle/currentness and dataset-scoped result reads.
All 58 migrations and 43 SQL assertion suites are required.
Coverage tables pin Network identities and hashes but do not copy Node, Edge,
Arc, Turn, Profile, or Condition authority.

The Spatial Provider uses its own read-only connection and may read only
`gowm_spatial_v1`. SQL-level scope filtering returns opaque `ReferenceKey`
values rather than internal Foundation identifiers. Current projection queries
declare `CONSISTENT_AT_START`, never a fabricated historical pinned version.

STAS remains an independently deployable application. It reads only the
versioned `gowm_stas_v1` contract and writes append-only evidence-oriented
AnalysisRecords; it does not become a Gateway or Foundation authority.

## Local verification

Node.js 22 or newer is required. On Windows PowerShell, use `npm.cmd` in place
of `npm`.

```bash
npm ci
npm run check
npm run verify:sql
npm test
npm run validate:boundaries
npm run validate:gowm-v05-migrations
npm run validate:gowm-v05-performance
npm run validate:gowm-v06-security-recovery
npm run validate:provider-conformance
node validation/scripts/gowm-v061-final-candidate.mjs
node validation/architecture/validate-release-boundaries.mjs
```

Real local stability gates require an exact task-owned disposable database
container name and explicit gate consent; see the operations runbook. Old-data
upgrade runs retained in D00 are supplemental evidence, not compatibility promises.

## License and release boundaries

- CRS and Geometry source inputs have no selected project-level license.
  Their expanded source, packages, and images must not be distributed as GOWM+
  artifacts. Only original GOWM bridge code, contracts, locks, tests, and
  evidence are eligible for this repository.
- H3 Spatial Toolkit `0.3.0` is locked to commit
  `74fc8657072dd58a2f8e4317c1caef8bfd10e024` and Apache-2.0 attribution/SBOM
  material is retained.
- Spatial Analysis input is Apache-2.0; the GOWM bridge is an original
  `gowm_spatial_v1` implementation and retains its Notice/SBOM.
- `.intake` and the uploaded Provider ZIPs are excluded from tracked and release
  artifacts.
- The uploaded road-coverage reference has `licenseStatus=UNSPECIFIED` and is
  reference-only. Its source, dependencies, builds, coverage output, and local
  environment files are not copied into or distributed with this repository.

## Known qualifications and non-claims

- The current Gateway bearer-token integration is a controlled deployment
  mechanism, not a production IdP or authorization system.
- Exact real-runtime execution of the formerly locked CRS, Geometry, Spatial
  POC and H3 Toolkit inputs was waived as a Required release gate. Their
  historical hashes/revision remain listed in
  `reports/gowm-v0.4/c02-v02-real-runtime-closure.md`; no execution claim is
  made for them.
- Operating-area CRS/grid certification, production mixed-load qualification,
  HA, and backup/PITR rehearsal remain explicit production non-claims.
- Basic Route results are plans over pinned inputs. They are not device
  dispatch, execution authorization, physical completion, observed reality,
  regional road coverage, or multi-vehicle optimization.
- Road Coverage results are single-route computational plans. Stable v0.6
  rejects either-direction service, `routeCount > 1`, fleet/capacity/time-window
  fields, CARP/OR-Tools behavior, and dispatchable semantics. A verified plan is
  not proof of dispatch, execution, completion, safety, or Operational Reality.
- The recorded Snap/Shortest/Matrix timings use the S/M acceptance fixture;
  they are regression budgets, not production SLO or capacity claims.
- The legacy H3 Situation projection is safe only for its configured single
  scope; arbitrary multi-scope serving remains blocked until the underlying
  projection is scope-aware.
- PR #6 is the review candidate. Final acceptance requires its Ready state and
  exact local/tracking/remote/PR SHA equality; merge, tag, release, image
  publication, and deployment remain user-controlled actions.

## Documentation and evidence

- [v0.2 architecture](docs/architecture/CAPABILITY_PLATFORM_V0.2.md)
- [Capability contract ADR](docs/adr/002-capability-platform-contract-boundaries.md)
- [Network and routing authority ADR](docs/adr/005-network-routing-authority.md)
- [Road coverage authority ADR](docs/adr/006-road-coverage-planning-authority.md)
- [Road coverage architecture](docs/architecture/ROAD_COVERAGE_PLANNING_V0.6.md)
- [Road coverage operations runbook](docs/19_ROAD_COVERAGE_OPERATIONS_RUNBOOK.md)
- [v0.6.1 platform-hardening runbook](docs/20_PLATFORM_HARDENING_OPERATIONS_RUNBOOK.md)
- [Platform-hardening authority ADR](docs/adr/ADR-0061-platform-hardening-authority.md)
- [Project status](PROJECT_STATUS.md)
- [Traceability](validation/TRACEABILITY.md)
- [Phase evidence](reports/capability-platform-v0.2/)
- [v0.3/v0.4 phase evidence](reports/gowm-v0.4/)
- [v0.1 unified architecture](docs/17_UNIFIED_PLATFORM_V0.1.0.md)
- [v0.5 operations runbook](docs/18_OPERATIONS_RUNBOOK.md)

The v0.1/v0.2 baselines and their evidence remain preserved. Stable-candidate
completion authorizes initiating review/merge to `main`; tag, release, and
production deployment remain separate actions.
