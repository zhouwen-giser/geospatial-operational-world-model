# Upgrade guide: GOWM v1.1 to GOWM+ v1.2

Migration 009 is an in-place, transactional schema upgrade. It preserves every
v1.1 observation and trajectory row, backfills canonical child records and then
changes the public `trajectory_point` name into a compatibility view. It is not a
zero-downtime production migration and has no SQL downgrade path.

## Preconditions

1. Stop Observation Ingest and Projection Worker writers.
2. Take and test a physical/logical backup. Record extension versions and row
   counts for `world_observation`, `trajectory_point` and current-state tables.
3. Certify `ANALYSIS_SRID` for the operating area. It must be a registered,
   projected, metre-unit CRS. The default 32650 is only a PoC example.
4. Build/pull the pinned PostgreSQL 18/PostGIS 3.6/MobilityDB 1.3 image plus
   h3-pg 4.5. Migration from PostgreSQL 17 requires a database major-version
   upgrade procedure; replacing an image against an old data directory is not
   valid.
5. Confirm free disk for rewritten indexes and the retained v1.1 archive.

## Migration behavior

| v1.1 artifact | v1.2 result |
|---|---|
| `world_observation` | enriched immutable envelope; old rows placed in `default` TEST scope with explicit legacy quality flags |
| single `observed_at` | one legacy identity clock model and one half-open TimeSolution per row |
| `geometry` + untyped value | canonical Measurement; point rows get PositionMeasurement with accuracy `UNKNOWN` |
| `trajectory_point` table | renamed to `trajectory_point_v11_archive` and retained unchanged |
| historical point reads | `trajectory_point` compatibility view over current canonical observation revisions |
| implicit point continuity | source-local immutable MobilityDB SequenceSet built with explicit continuity and gap rules |
| current object state | retained; gains frozen time/measurement/projection/uncertainty references for future projections |

Legacy data does not acquire fabricated accuracy, continuity or identity
confidence. Because v1.1 did not carry tracker sessions, migrated source-local
IDs use the explicit `__UNSCOPED__` tracker-session key; because it did not carry
a continuity token, each legacy point is conservatively a singleton sequence.
Future sources must publish an actual continuity token and, when local IDs can be
reused, `trackerSessionId`.

## From-empty validation

```bash
cp .env.example .env
# Set matching URL-safe POSTGRES_PASSWORD and DATABASE_URL values.
npm ci
npm run verify:v1.2
docker compose config --quiet
docker compose up -d --build
docker compose exec -T postgres psql -U gowm -d gowm -v ON_ERROR_STOP=1 \
  < database/tests/001_v12_assertions.sql
docker compose run --rm world-api node dist/scripts/seed.js
RUN_DB_INTEGRATION=1 npm run test:integration
npm run build
node dist/tests/integration/http-acceptance.js
```

## Populated v1.1 rehearsal

Use a disposable restored copy, never the only database:

1. Restore the v1.1 backup into PostgreSQL 18 by the approved major-upgrade
   procedure.
2. Record pre-migration row/content hashes.
3. Run `npm run db:migrate` with the final AnalysisSpace and Tracklet rule values.
4. Assert migration 009 is recorded once; rerunning must skip it with the same
   checksum and fail if configuration/source text changed.
5. Run `database/tests/001_v12_assertions.sql`.
6. Compare counts: every old Observation has a TimeSolution and Measurement;
   every old point row remains in the archive and appears through the read view.
7. Sample trajectories with known gaps and verify SequenceSet mid-gap position is
   NULL.
8. Run API acceptance, then repeat after service/container restart.
9. Measure migration time, locks, WAL and disk before scheduling production.

## Compatibility window

- v1.1 `POST /observations` remains accepted through the adapter for one release.
- v1.1 `GET /trajectory/.../track` remains, now explicitly an observed-measurement
  compatibility representation.
- Direct inserts into `trajectory_point` stop at v1.2. Writers must use canonical
  Observation ingestion.
- Direct consumers of the old table must either use the view or move to
  `/trajectory/:id/mobility` / STAS contracts.

## Rollback

Rollback is backup restore or blue/green cutback, not reverse DDL. Do not drop the
archive until the compatibility window, hash comparison and restore drill all
pass. A v1.1 application must never write to a database after migration 009.

## Promotion gates

Production promotion requires: populated upgrade rehearsal, backup/restore/PITR,
authentication and scope mapping, operating-area CRS evidence, target-scale
latency/candidate tests, pool timeout/cancellation tests and image SBOM/signing.
