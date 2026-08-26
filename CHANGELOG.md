# Changelog

## 0.6.1 - 2026-08-26

- Made Coverage claims database-authoritative and generation-fenced; stale
  workers cannot heartbeat, persist, or publish after reclaim or cancellation.
- Added shared Network Query Core, independent versioned boundary-crossing
  reconstruction, fixed-point weighted and least-deadhead objectives, truthful
  result hashes, explicit traversal/coverage credit, and fail-closed
  `NO_FEASIBLE_PLAN` semantics.
- Added deterministic Capability semantic projection, scoped Data Product
  discovery/detail operations, and the Platform Validation Provider with
  `result.validate`, `snapshot.get`, and `snapshot.validate` current/stale/unknown
  behavior over existing authorities.
- Added append-only migrations 054–057, SQL assertions through 042, nine-provider
  conformance evidence, real PostgreSQL/Gateway/restart gates, and a 229-case
  fail-closed final acceptance aggregator.
- Passed real fresh/v0.4/v0.5/v0.6.0 upgrade, 150 Gateway checks, 72 pre-/5
  post-restart checks, and compatibility gates. Retained per-case evidence,
  runtime source locks, failed-attempt explanations, and bounded S/M timings.
- Preserved migrations 001–053 and existing v1.0 wire bytes. WSGS readiness,
  separate Data Platform Readiness, mock ELEVATION onboarding, merge, tag,
  release, and deploy are explicitly outside this release task.

## 0.6.0 - 2026-08-25

- Added stable single-route road coverage planning over the authoritative v0.5
  Network Foundation, with four area/manual selection modes, exact partial-Arc
  service obligations, explicit endpoint/boundary policies, and strict
  separation of required obligations R from traversable network E.
- Added Closed/Open Directed CPP and fixed/both-direction RPP solving with
  pairwise and multi-edge turn restrictions, fixed-point objectives, bounded
  candidate generation, deterministic alternatives, and an independently
  implemented verifier with mutation evidence.
- Added the five-operation `gowm.road-coverage-planning` Provider, trusted
  Gateway Job/DAG integration, generation-fenced async execution, immutable
  QUERY_RESULT/DERIVED_REFERENCE publication, TTL/revalidation, and ordered
  on-demand GeoJSON expansion.
- Added migrations through 053 and 38 SQL assertion suites; fresh, v0.4→v0.6,
  exact v0.5→v0.6, checksum replay, rollback, scope adversarial, Small/Medium
  performance, concurrent duplicate, cancellation-race, and PostgreSQL restart
  gates pass on real PostgreSQL/PostGIS/pgRouting.
- Retained `NETWORK_READY` and `ROUTING_READY` and declared
  `ROAD_COVERAGE_READY`. Stable v0.6 does not claim either-direction service,
  multiple routes, fleet/capacity/time-window optimization, CARP/OR-Tools,
  dispatchability, physical execution, or production SLO/HA qualification.

## 0.5.0 - 2026-08-25

- Added the authoritative immutable Network Dataset→GraphVersion foundation,
  deterministic topology builder, directed Arcs, pairwise and multi-edge turn
  restrictions, travel/cost profiles, versioned Condition Snapshots, validation,
  diagnostics, replay, and atomic activation.
- Added the scoped, read-only `gowm_network_v1` contract, the 11-operation
  `gowm.network` Provider, and the four-operation `gowm.route-planning`
  Provider with coordinate/reference endpoints, ordered Waypoints, Via/Avoid
  constraints, exact PostGIS Avoid Area evaluation, five fixed-point objectives,
  immutable QUERY_RESULT publication, TTL, cancellation, and exact replay.
- Added an independent route verifier that replays arc identity, continuity,
  direction, fractions, turn legality, metrics, pinned freshness, and mutation
  detection without importing solver legality or cost helpers.
- Added PostgreSQL 18.6/PostGIS 3.6.4/MobilityDB 1.3.0/H3 4.5.0/pgRouting 4.0.1
  runtime evidence, migrations through 047, 32 SQL assertions, fresh and
  v0.4→v0.5 migration gates, restart recovery, measured S/M fixture gates,
  log redaction, and DB/service SBOMs.
- Declared `NETWORK_READY` and `ROUTING_READY`. A Route Plan remains a pinned
  computational result, not dispatch, observed reality, coverage proof, or a
  production-sized performance/availability claim.

## 0.4.0 - 2026-08-24

- Added frozen v0.3 Reference, Dataset/Layer/Feature, derived-result, and World
  Evidence contracts with four controlled Grounding Providers and 28 Gateway
  capabilities.
- Added immutable OperationalTask events, four-dimensional projections,
  correlation claims/findings, external predicate evaluation, observability,
  analysis replay, and the independently served Operational Reality Provider.
- Proved `GROUNDING_READY` and `OPERATIONAL_REALITY_READY` over real HTTP and
  PostgreSQL, including typed DAGs, exact replay, cancellation races, and
  Gateway/database restart recovery.
- Added stable byte locks, clean/v0.1/v0.2 migration paths through migration
  032, replay checksums, cross-scope adversarial checks, and measured local
  search/timeline/projection gates.
- Promoted the stable candidate to `0.4.0` after the release owner explicitly
  removed exact CRS, Geometry, Spatial ZIP and H3 Toolkit revision execution
  from the Required gate policy. AC-C007/AC-C008 and downstream AC-S019/AC-S021
  pass by that policy override; this is not a claim that those external inputs
  were executed.

## 0.2.0 - Unreleased

- Added JSON-Schema-first Capability Provider, result, receipt/evidence,
  snapshot, Gateway, and World Query v2 contracts with generated TypeScript and
  deterministic schema locks.
- Added the Provider SDK and conformance kit, controlled Capability Registry,
  direct execution, health/circuit isolation, idempotency, audit, typed DAG
  execution, asynchronous jobs, cancellation, and persistence adapters.
- Added local-only Foundation CRS, Geometry, and h3-pg ports so projection does
  not synchronously depend on the Gateway or remote Providers.
- Added original GOWM bridges and manifests for locked CRS, Geometry, H3
  interactive/analysis, GOWM H3 Situation, and Spatial capabilities. The
  controlled catalog declares 50 versioned operations.
- Added opaque ReferenceKeys, the scope-filtered `gowm_spatial_v1` read
  contract, Foundation processing receipts, World Query persistence, and
  separate least-privilege runtime, Registry-bootstrap, Spatial, and Situation
  database roles.
- Refactored GOWM H3 Situation to delegate generic H3 primitives to the locked
  local H3 Toolkit adapter while retaining GOWM-owned World Version and metric
  projection semantics.
- Added legacy World read compatibility modes and split MCP read/analysis tools
  from Observation command tools.
- Retained strict release boundaries: expanded Provider inputs remain excluded;
  CRS/Geometry source, packages, and images are not publishable without a
  project-level license; H3/Spatial Apache-2.0 Notice and SBOM material remains.
- Candidate status is **BLOCKED**. Required real external Provider,
  PostgreSQL/Docker, exact cross-capability, scope, and restart gates remain
  `NOT_RUN/BLOCKED`; implementation changes are not committed/pushed, Draft PR
  #1 remains Draft, and no merge/tag/release/deploy occurred.

## 0.1.0 - 2026-08-13

- Integrated the GOWM v1.2 and validated STAS baselines into one authority model.
- Added the pinned PostgreSQL 18/PostGIS 3.6/MobilityDB 1.3/H3 4.5 database,
  versioned `gowm_stas_v1` contract, restricted STAS role, and append-only sink.
- Removed STAS-owned canonical ingestion and Tracklet build code and routes.
- Added all 15 P0 tool routes, OpenAPI parity, persisted scoped replay, integrated
  deterministic fixtures, 10,001-candidate cap validation, and analyzed plans.
- Fixed canonical position ingestion binding, fresh-database health, extension
  build, MobilityDB assertion, scope-trigger, and candidate-index defects.
- Added v0.1.0 architecture, operations, traceability, acceptance, and packaging.

## 1.2.0 — 2026-08-13

- Defined GOWM+ as the unified data foundation and STAS as an independent
  deterministic analysis application.
- Added PostgreSQL 18/PostGIS 3.6/MobilityDB 1.3 reference database image and
  retained h3-pg 4.5.
- Replaced raw `trajectory_point` writes with immutable source-local MobilityDB
  TrackletVersion SequenceSets, explicit UNKNOWN gaps, frozen inputs and lineage.
- Expanded `world_observation` into an immutable revisioned event envelope and
  added TimeSolution, typed Measurement/PositionUncertainty and Assertion models.
- Added data scope, AnalysisSpace, source/pipeline/stream, clock and processing
  provenance registries plus ownership constraints.
- Added frozen provenance to current world-state projection and blocked unresolved
  candidate bindings from projection/replay.
- Added strict canonical v1.2 ingestion, server-owned receipt time, v1.1
  compatibility adapter, canonical evidence read API and Mobility trajectory API.
- Added STAS read contracts and append-only scope-consistent analysis evidence
  records.
- Added PostgreSQL grammar validation, MobilityDB runtime assertions and a
  canonical HTTP acceptance scenario with an explicit continuity gap.

## 1.1.0

Original PostGIS/h3-pg world-state, spatial query, H3 situation, MQTT event,
point-history and MCP PoC baseline.
