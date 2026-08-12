import { describe, expect, it } from "vitest";
import { databasePool, closeDatabasePool } from "../../packages/runtime/src/db.js";
import { WorldRepository } from "../../packages/runtime/src/world-repository.js";

const enabled = process.env.RUN_DB_INTEGRATION === "1";

describe.skipIf(!enabled)("PostGIS integration", () => {
  it("reports PostGIS/h3-pg health, native H3 storage and monotonic world version", async () => {
    const pool = databasePool();
    const repository = new WorldRepository(pool);
    const health = await repository.health();
    expect(health.database).toBe("ok");
    expect(health.postgisVersion).toMatch(/^3\./);
    expect(health.h3PgVersion).toBe("4.5.0");
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
         ('trajectory_point', 'h3_r9'),
         ('situation_cell', 'h3_index')
       )
       ORDER BY c.relname, a.attname`
    );
    expect(storage.rows).toHaveLength(3);
    expect(storage.rows.every((row) => row.data_type === "h3index")).toBe(true);
    await closeDatabasePool();
  });
});
