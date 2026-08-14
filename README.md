# Geospatial Operational World Model Plus (GOWM+) v0.1.0

GOWM+ is a unified operational spatiotemporal platform. GOWM owns canonical
observations, corrected time, typed measurements, uncertainty, spatial objects,
and immutable source-local MobilityDB TrackletVersions. STAS is an independently
deployable application that reads only the versioned `gowm_stas_v1` contract and
writes append-only evidence-oriented `AnalysisResult` records.

The governing rule is: an Observation is not State, a Tracklet is not a
real-world identity, interpolation is not an observation, and missing evidence
is not a negative fact.

## Runtime baseline

- PostgreSQL 18
- PostGIS 3.6, including raster
- MobilityDB 1.3
- h3-pg and h3_postgis 4.5.0
- Node.js 22 or newer

The database image builds h3-pg 4.5.0 from the checksum-pinned official PGXN
source because the available PGDG PG18 package was older during validation.

## Ownership

| Boundary | Authority |
|---|---|
| GOWM foundation | DataScope, AnalysisSpace, Source/Pipeline/Datastream, Observation, TimeSolution, Measurement, uncertainty, SpatialObject, TrackletVersion, projection |
| STAS application | 15 deterministic P0 analyses and append-only AnalysisRecord/Evidence rows |
| Agent/application layer | composition and reasoning through service contracts; no direct fact mutation |

STAS has no observation-ingest or tracklet-build route or implementation. Its
database login has contract-view reads and analysis-sink inserts only.

## Quick start

Copy `.env.example` to `.env`, select a unique `COMPOSE_PROJECT_NAME`, generate
separate long `POSTGRES_PASSWORD` and `STAS_DB_PASSWORD` values, and certify a
projected metre `ANALYSIS_SRID` for the operating area.

```bash
npm ci
npm run verify
docker compose config --quiet
docker compose up -d --build postgres migrate stas
curl http://127.0.0.1:8080/readyz
curl http://127.0.0.1:8080/v1/tools
```

Windows PowerShell uses `npm.cmd` and `docker compose` with the same arguments.
See [the operations runbook](docs/18_OPERATIONS_RUNBOOK.md) for migrations,
fixtures, backup/restore, rollback, and evidence commands.

## STAS API

- `GET /healthz`
- `GET /readyz`
- `GET /v1/tools`
- `GET /v1/tools/{name}`
- `POST /v1/tools/{name}:execute`
- `GET /v1/analyses/{analysisId}`

Both execution and replay require an authorized `x-data-scope-id`; execution
also requires the same UUID in `body.dataScopeId`. The OpenAPI contract is at
`services/stas/openapi/openapi.yaml`.

## Verified scope and release status

The isolated validation run proved a fresh 10-migration install, exact extension
versions, role denials, all 15 tools through HTTP and real SQL, persisted replay,
cross-scope denial, a GOWM observation API to TrackletVersion to STAS chain, and
a 10,001-candidate cap with an analyzed query plan. See
[final acceptance](validation/FINAL_ACCEPTANCE.md) and
[runtime evidence](validation/evidence/runtime-and-performance.json).

Decision: **INTEGRATION_CONDITIONAL_PASS**. Production promotion remains blocked
until an operating-area CRS is certified, authentication supplies trusted scope
claims, MQTT recovery is exercised with a live broker, backup/PITR is rehearsed,
and target-environment SLO/load gates pass. Merge, tag, release, and deployment
are protected user-controlled actions.

## Documentation

- [Unified architecture](docs/17_UNIFIED_PLATFORM_V0.1.0.md)
- [Ownership matrix](docs/architecture/DATA_OWNERSHIP_MATRIX.md)
- [Integration ADR](docs/adr/001-unified-gowm-foundation-stas-application.md)
- [Operations runbook](docs/18_OPERATIONS_RUNBOOK.md)
- [Traceability](validation/TRACEABILITY.md)
- [Defect register](validation/defects/defect-register.md)

The two supplied ZIP inputs remain excluded from the engineering package but
their names, hashes, and internal-manifest verification are recorded in
`docs/intake/INPUT_BASELINES.md`.
