# GOWM+ / standalone STAS overlap inventory

## Decision

GOWM+ is the single authority for scope, source, observation, time solution,
measurement, uncertainty, spatial/sensor facts, and source-local tracklet
versions. STAS is imported only as an HTTP analysis application. Its standalone
ingest/build endpoints and duplicate fact migrations are reference inputs and
are not installed in the integrated database.

## Database mapping

| Standalone STAS object | Integrated disposition | GOWM+ authority / STAS ownership |
|---|---|---|
| `st.data_scope`, `st.analysis_space` | delete as writable copies; expose versioned read contracts | `data_scope`, `analysis_space` |
| `st.source`, `st.processing_run`, `st.source_clock_model`, `st.producer_pipeline`, `st.datastream` | delete as writable copies; map read contracts | GOWM+ source/governance tables |
| `st.observation_event`, `st.observation_head` | delete | `world_observation`, `world_observation_head` |
| `st.observation_time_solution` | delete | `observation_time_solution` |
| `st.measurement`, `st.position_measurement` | delete | `measurement`, `position_measurement` |
| `st.tracklet*`, builder jobs/functions | delete from STAS authority | `mobility_tracklet*` and GOWM build command |
| `st.spatial_object*`, sensor/deployment/coverage/status/watermark | migrate missing fields into GOWM+ foundation | GOWM+ owned contracts |
| `st.analysis_record` and typed analysis inputs/evidence | migrate and retain as STAS-owned append-only sink | STAS owns derived analysis records only |
| `st` P0 SQL templates | reuse through read-only contract views | STAS application code |

## API mapping

| Standalone endpoint | Integrated disposition |
|---|---|
| `POST /v1/observations:ingest` | removed from STAS; GOWM observation-ingest owns publish/revision |
| `POST /v1/tracklets:build` | removed from STAS; GOWM owns source-local build |
| `GET /healthz`, `GET /readyz` | retained |
| `GET /v1/tools`, `GET /v1/tools/{name}` | retained |
| `POST /v1/tools/{name}:execute` | retained |
| `GET /v1/analyses/{analysisId}` | added as persisted-result read |
| async job placeholder | excluded from v0.1.0 authority contract |

## Migration rule

Standalone STAS migrations 001-050 are never appended wholesale because doing
so creates a second Observation/Measurement/Tracklet truth. Integrated numbered
migrations add missing foundation capabilities, versioned STAS contract views,
roles/grants, and the append-only analysis sink. Compatibility views are
read-only and versioned; STAS must not query undeclared GOWM internals.
