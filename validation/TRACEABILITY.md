# v0.1.0 traceability

| Requirement | Implementation | Evidence/status |
|---|---|---|
| Audit both supplied baselines | `docs/intake/INPUT_BASELINES.md` | ZIP and internal-manifest hashes PASS |
| One canonical authority | ownership matrix, ADR, migrations 009-010 | PASS |
| Pinned PG18/PostGIS3.6/MobilityDB1.3/H3 4.5 | `database/Dockerfile`, migrations 008-010 | runtime versions PASS |
| Stable Observation/TimeSolution/Measurement/TrackletVersion | migration 009, observation repository | fresh migration and API-to-DB PASS |
| Versioned STAS adapter, no duplicate writer | `gowm_stas_v1`, restricted role, removed command code | role audit and route parity PASS |
| Independent STAS deployment | Compose `stas`, health/readiness | PASS |
| All 15 P0 tools | registry, repository, SQL templates, OpenAPI | 15/15 real HTTP+DB PASS |
| Evidence-oriented result persistence | `stas.analysis_*`, replay route | persistence/replay/scope denial PASS |
| Gap and uncertainty semantics | Mobility SequenceSet/gaps, domain tests | UNKNOWN gap and NO_DATA PASS |
| Candidate cap and plans | fixture 002, scoped index, evidence collector | 10,001 universe; cap 5,000; PASS |
| Repeatable engineering verification | npm scripts, SQL AST, unit tests, build | PASS |
| Backup/restore/PITR | operations runbook | procedure delivered; rehearsal NOT_RUN |
| Live MQTT recovery | durable queue/outbox observed during focused ingest E2E | PARTIAL; broker recovery NOT_RUN |
| Production authentication and CRS | deployment responsibility | BLOCKED pending external inputs |
| Merge/tag/release/deploy | protected action | NOT_RUN pending explicit authorization |
