# GOWM+ v1.2 database model

The schema has four ownership zones:

1. Foundation registries: `data_scope`, `analysis_space`, `source_registry`,
   `producer_pipeline`, `datastream`, `processing_run`, `source_clock_model`.
2. Immutable evidence: `world_observation`, `observation_time_solution`,
   `measurement`, `position_measurement`, `observation_assertion`.
3. Projections: current `world_object*`, H3 situation and versioned
   `mobility_tracklet*`.
4. Application evidence: append-only `analysis_record` plus frozen typed
   input/evidence references.

`world_observation` is an event envelope, never a bag for every measurement.
Corrected time, typed position accuracy and algorithm assertions are separate.
Operational status fields are the only mutable part of the envelope; corrections
publish a new source revision.

`trajectory_point_v11_archive` preserves old bytes. `trajectory_point` is a
read-only compatibility view over current canonical position-measurement
revisions. New movement truth is an immutable
`tgeompoint(SequenceSet,Point)` TrackletVersion. A sequence means explicitly
continuous under a versioned rule profile. An open interval in
`mobility_tracklet_gap` and the space between sequences is UNKNOWN.

STAS may read `gowm_stas_position_observation_v1` and
`gowm_stas_tracklet_version_v1`; it must not update foundation tables. Results
append to the analysis tables with frozen scope-consistent references.

Run source and runtime validation:

```bash
npm run verify:sql
docker compose exec -T postgres psql -U gowm -d gowm -v ON_ERROR_STOP=1 \
  < database/tests/001_v12_assertions.sql
```

Migration 009 validates that the configured AnalysisSpace is a registered
projected metre CRS. Do not use the PoC SRID without validating its area of use
and transformation error budget.
