# Changelog

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
