# Geospatial Operational World Model Plus (GOWM+)

GOWM+ combines an authoritative geospatial data foundation with an extensible
Capability Service Plane and a controlled World Capability Gateway. The
`0.4.0-rc.1` candidate adds stable Grounding and Operational Reality contracts,
four controlled Grounding Providers, immutable operational evidence and
projections, typed World Query DAGs, and replay/recovery gates without moving
domain algorithms into the Gateway.

> **Candidate status (2026-08-24): BLOCKED_EXTERNAL.** All runnable v0.3/v0.4
> gates pass, including real PostgreSQL, Provider/Gateway HTTP, scope,
> migration, replay, cancellation, and restart checks. Final `0.4.0` promotion
> and Ready-for-Review remain blocked only by the absent immutable CRS,
> Geometry, Spatial POC archives and H3 Toolkit revision required by
> AC-C007/AC-C008. Draft PR #2 has not been merged, tagged, released, or
> deployed.

See [PROJECT_STATUS.md](PROJECT_STATUS.md) for the exact delivery boundary and
[the v0.2 architecture](docs/architecture/CAPABILITY_PLATFORM_V0.2.md) for the
trust and ownership model.

## Architecture

| Plane | Responsibility | Prohibited responsibility |
|---|---|---|
| Data Foundation | Canonical observations, time, measurements, current projection, immutable TrackletVersions, `gowm_spatial_v1`, and local processing receipts | Synchronous dependency on the Gateway or remote Providers |
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

The checked-in manifests currently define 50 controlled operations. All
versions below are `1.0`; `PREVIEW` is the default maturity unless noted.

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

The stable Grounding registry adds four independently controlled Providers and
28 capabilities: Reference resolution/search/validation, Dataset/Layer/Feature
catalog access, World Evidence/result/reference-set reads, and eight
Operational Reality operations for tasks, timelines, correlation, predicates,
and observability. Their canonical v1 schemas are byte-locked under
`contracts/gowm-v0.4`.

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

The PostgreSQL 18 baseline includes PostGIS 3.6, MobilityDB 1.3, and h3-pg /
h3_postgis 4.5. Migrations `001`-`014` remain byte-locked; append-only
migrations through `032` add Grounding identity/catalog/result/evidence and
Operational Reality event/projection/correlation/predicate/observability
contracts.

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
node validation/scripts/stable-contract-compatibility.mjs
node validation/architecture/validate-release-boundaries.mjs
```

Real local stability gates additionally require an isolated PostgreSQL admin
URL and exact disposable database container name; see the operations runbook.

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

## Known blockers and non-claims

- The current Gateway bearer-token integration is a controlled deployment
  mechanism, not a production IdP or authorization system.
- Exact real-runtime execution of the locked CRS, Geometry, Spatial POC and H3
  Toolkit inputs remains `BLOCKED_EXTERNAL`; their required hashes/revision are
  listed in `reports/gowm-v0.4/c02-v02-real-runtime-closure.md`.
- Operating-area CRS/grid certification, production mixed-load qualification,
  HA, and backup/PITR rehearsal remain explicit production non-claims.
- The legacy H3 Situation projection is safe only for its configured single
  scope; arbitrary multi-scope serving remains blocked until the underlying
  projection is scope-aware.
- Final stable-version promotion and Ready-for-Review are prohibited while the
  two Required external gates remain blocked. Draft PR #2 must remain Draft.

## Documentation and evidence

- [v0.2 architecture](docs/architecture/CAPABILITY_PLATFORM_V0.2.md)
- [Capability contract ADR](docs/adr/002-capability-platform-contract-boundaries.md)
- [Project status](PROJECT_STATUS.md)
- [Traceability](validation/TRACEABILITY.md)
- [Phase evidence](reports/capability-platform-v0.2/)
- [v0.3/v0.4 phase evidence](reports/gowm-v0.4/)
- [v0.1 unified architecture](docs/17_UNIFIED_PLATFORM_V0.1.0.md)
- [Operations runbook](docs/18_OPERATIONS_RUNBOOK.md)

The v0.1/v0.2 baselines and their evidence remain preserved. No merge, tag,
release, or production deployment is authorized by this candidate.
