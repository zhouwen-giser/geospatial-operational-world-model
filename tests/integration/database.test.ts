import { describe, expect, it } from "vitest";
import { databasePool, closeDatabasePool } from "../../packages/runtime/src/db.js";
import { WorldRepository } from "../../packages/runtime/src/world-repository.js";

const enabled = process.env.RUN_DB_INTEGRATION === "1";

describe.skipIf(!enabled)("PostGIS integration", () => {
  it("reports PostGIS/MobilityDB/h3-pg health, canonical contract and monotonic world version", async () => {
    const pool = databasePool();
    const repository = new WorldRepository(pool);
    const health = await repository.health();
    expect(health.database).toBe("ok");
    expect(health.postgisVersion).toMatch(/^3\./);
    expect(health.mobilityDbVersion).toMatch(/^1\.3/);
    expect(health.h3PgVersion).toBe("4.5.0");
    expect(health.contractVersion).toBe("1.2.0");
    expect(health.analysisSrid).toBe(Number(process.env.ANALYSIS_SRID ?? 32650));
    expect(health.worldVersion).toBeGreaterThanOrEqual(0);
    const h3 = await pool.query<{ cell_type: string; resolution: number; parent_matches: boolean }>(
      `WITH cell AS (
         SELECT h3_latlng_to_cell(ST_SetSRID(ST_MakePoint(116.4, 39.9), 4326), 9) AS value
       )
       SELECT pg_typeof(value)::text AS cell_type,
              h3_get_resolution(value) AS resolution,
              h3_get_resolution(h3_cell_to_parent(value, 7)) = 7 AS parent_matches
       FROM cell`
    );
    expect(h3.rows[0]).toMatchObject({ cell_type: "h3index", resolution: 9, parent_matches: true });
    const storage = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT c.relname AS table_name, a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS data_type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE (c.relname, a.attname) IN (
         ('world_object_geometry', 'h3_r9'),
         ('trajectory_point_v11_archive', 'h3_r9'),
         ('situation_cell', 'h3_index')
       )
       ORDER BY c.relname, a.attname`
    );
    expect(storage.rows).toHaveLength(3);
    expect(storage.rows.every((row) => row.data_type === "h3index")).toBe(true);
    const mobility = await pool.query<{ data_type: string; sequence_count: number }>(
      `SELECT format_type(a.atttypid,a.atttypmod) AS data_type,0::integer AS sequence_count
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
       WHERE c.relname='mobility_tracklet_version' AND a.attname='trajectory'`
    );
    expect(mobility.rows[0]?.data_type).toContain("tgeompoint");
    const stableApi = await pool.query<{ as_mfjson: string; t_dwithin_geography: string | null; pair_helper: string | null }>(
      `SELECT to_regprocedure('asMFJSON(tgeompoint,integer,integer,integer)')::text AS as_mfjson,
              to_regprocedure('tDwithin(tgeogpoint,tgeogpoint,double precision)')::text AS t_dwithin_geography,
              to_regprocedure('eDwithinPairs(tgeompoint[],double precision)')::text AS pair_helper`
    );
    expect(stableApi.rows[0]?.as_mfjson).toBeTruthy();
    expect(stableApi.rows[0]?.t_dwithin_geography).toBeNull();
    expect(stableApi.rows[0]?.pair_helper).toBeNull();
    await closeDatabasePool();
  });
});
