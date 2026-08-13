# Changelog

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
