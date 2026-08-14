# GOWM+ v0.1.0 final acceptance

Decision: **INTEGRATION_CONDITIONAL_PASS**

Validation date: 2026-08-13

## Passed

- source ZIP hashes and internal integrity manifests
- clean PostgreSQL migration sequence 001-010 and checksum replay behavior
- PostgreSQL 18.4, PostGIS/PostGIS Raster 3.6.4, MobilityDB 1.3.0,
  h3/h3_postgis 4.5.0, configured SRID 32652 in the isolated test deployment
- role boundary: contract SELECT and sink INSERT allowed; canonical table
  SELECT/UPDATE denied
- TypeScript checks, SQL AST verification, root unit/scenario tests, STAS tests,
  OpenAPI/registry parity, and production build
- deterministic integrated scenario with continuous sequences, explicit UNKNOWN
  gap, pair/region/successor/coverage facts, and strict scope isolation
- 15 of 15 P0 tools over real PostgreSQL/MobilityDB through HTTP
- immutable AnalysisRecord persistence, typed evidence inputs, scoped replay, and
  cross-scope denial
- canonical GOWM observation API to three immutable TrackletVersions to STAS
  analysis, including exact idempotent replay
- 10,001-tracklet candidate universe rejected at the 5,000 synchronous cap;
  final clean-volume analyzed probe completed in 45.179 ms with the scoped index present

Machine-readable runtime/plan evidence is in
`validation/evidence/runtime-and-performance.json`. Defects GSI-001 through
GSI-012 are fixed with clean-volume regression evidence.

## Partial or not run

- MQTT: the focused canonical-ingest chain deliberately used an unavailable
  broker and verified durable queue/outbox retention; live broker recovery is
  `PARTIAL` and is not counted as delivered transport.
- backup/restore/PITR: runbook delivered, rehearsal `NOT_RUN`.
- production load/SLO: 10,001-candidate plan proven; broad target p95/p99 load
  `NOT_RUN`.
- production authentication and scope claims: `BLOCKED` on deployment identity
  provider; the current header is an integration boundary, not production auth.
- operating-area CRS certification: `BLOCKED` on deployment geography.
- merge, tag, release, and deployment: `NOT_RUN`; protected user-controlled actions.

## Publication gate

The source branch may be committed and pushed with this conditional decision.
Do not merge to the protected default branch, create a release tag, publish an
image, or deploy until explicit authorization and the production blockers above
are resolved.
