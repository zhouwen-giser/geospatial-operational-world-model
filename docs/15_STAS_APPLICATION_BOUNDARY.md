# GOWM+ foundation and STAS application boundary

## Integration rule

GOWM+ is the only owner of canonical Observation and source-local movement
versions. STAS must not independently ingest the same source record and build a
second mutable Tracklet truth. STAS receives frozen IDs/versions, performs a
bounded deterministic analysis and appends an evidence result.

```text
GOWM canonical evidence/version
  -> STAS candidate filter
  -> exact MobilityDB/PostGIS calculation
  -> AnalysisResult envelope
  -> frozen input/evidence references in GOWM analysis tables
  -> Agent/API adapter
```

## Model mapping

| Standalone STAS Phase 0 concept | Integrated GOWM+ v1.2 contract |
|---|---|
| DataScope | `data_scope` |
| AnalysisSpace | `analysis_space` |
| Source / pipeline / stream | `source_registry`, `producer_pipeline`, `datastream` |
| Clock model | `source_clock_model` |
| ObservationEvent | `world_observation` |
| TimeSolution | `observation_time_solution` |
| Measurement / PositionMeasurement | `measurement`, `position_measurement` |
| ObservationAssertion | `observation_assertion` |
| source-local Tracklet and versions | `mobility_tracklet*` |
| AnalysisRecord / frozen inputs / evidence | `analysis_record`, `analysis_*_input`, `analysis_evidence_reference` |

Standalone STAS Phase 0 schema remains valuable as a validated reference and
isolated test deployment. In an integrated deployment its repository adapter
must map to the contracts above instead of duplicating facts.

## Supported coupling modes

### Same database, separate service (recommended for v1.2 PoC)

STAS receives read-only access to:

- `gowm_stas_position_observation_v1`;
- `gowm_stas_tracklet_version_v1`;
- required spatial/coverage version contracts.

It receives narrowly scoped insert rights to its append-only analysis record and
typed input/evidence tables. It never receives UPDATE/DELETE on foundation
evidence. Production roles/RLS are a promotion gate; the PoC does not claim them.

### Separate database/service

Use an outbox/CDC adapter with immutable keys and hashes. Delivery may be
at-least-once; the receiving projection must be idempotent. GOWM remains the
authority. Never blind dual-write from an adapter to both databases.

The HTTP equivalent is `GET /observations/:id/canonical` plus the Mobility
trajectory/version endpoint. High-volume production should use an outbox feed,
not polling individual records.

## API ownership

| Endpoint/tool family | Owner |
|---|---|
| world object/current state, spatial lookup, H3 situation, geometry metadata | GOWM+ / future foundation apps |
| canonical observation publish/read and source-local movement read | GOWM+ |
| time/region/motion/proximity/successor/pair evidence | STAS |
| same entity, following, companion, contact, suspicious, intent | Agent/domain reasoning layer |

STAS output must include status, scope, frozen subjects/inputs, temporal/spatial
coverage, gaps, uncertainties, assumptions, evidence references, method/version
and quality. `true/false` alone is not a sufficient result.

## Failure and consistency rules

- Missing common temporal domain yields `NO_DATA`, not false.
- Missing coverage/status/watermark yields `INDETERMINATE`; absence is not
  negative evidence.
- Candidate caps fail closed before exact calculation; no silent truncation.
- Statistical uncertainty is not promoted to a hard radius.
- A world-object binding is optional metadata on a Tracklet, not its identity.
- Analysis repeats append separate records; a snapshot hash supports audit/cache
  diagnosis and is deliberately not unique.

## Next integration increment

1. Adapt the validated STAS repository to the two GOWM read views and GOWM
   analysis sink.
2. Run the existing 15 P0 tool suite against GOWM-generated TrackletVersion IDs.
3. Add authenticated scope claims and database roles.
4. Add sensor deployment/pose/FOV/status/coverage contracts before enabling
   negative evidence tools.
5. Move source-local builder execution to a durable asynchronous queue once
   accepted position rate makes full synchronous rebuild material.
