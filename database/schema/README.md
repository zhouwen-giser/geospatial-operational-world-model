# Database model

`world_object` holds identity and slow-changing properties. `world_object_state`
holds authoritative current state and provenance. `world_object_geometry` is the
current spatial projection. Observations, events, trajectory points, and H3
situation cells are separate historical/derived models.

Migration `008_h3_pg.sql` enables `h3` and `h3_postgis`, then upgrades the v1.0
portable text columns to native `h3index`. Runtime point/polygon projection,
neighbors and hierarchy use h3-pg functions. `h3-js` remains only for
database-free scenario tests, request validation and response boundaries.

Key consistency rules:

- `world_observation` is immutable input history.
- `projection_queue` makes accepted observations recoverable after a broker or
  worker outage.
- `world_object_state.version` comes from a monotonic database sequence.
- derived state contains `source_observation_id`, confidence, source, and both
  observation and receipt times.
- current position is in `world_object_geometry`; history is in
  `trajectory_point`.
- H3 resolution constraints must match the resolution encoded in `h3index`.
