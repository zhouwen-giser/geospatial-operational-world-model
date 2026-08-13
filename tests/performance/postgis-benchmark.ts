import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { databasePool, closeDatabasePool } from "../../packages/runtime/src/db.js";

interface ScaleResult {
  objects: number;
  insertWithH3Ms: number;
  nearbyP50Ms: number;
  nearbyP95Ms: number;
  nearbyP99Ms: number;
  withinP95Ms: number;
  nearestP95Ms: number;
  h3ExactP95Ms: number;
  h3ParentFilterP95Ms: number;
}

async function main(): Promise<void> {
  const maxObjects = Number(process.env.BENCH_MAX_OBJECTS ?? 1_000_000);
  const scales = [1_000, 10_000, 100_000, 1_000_000].filter((value) => value <= maxObjects);
  const pool = databasePool();
  const client = await pool.connect();
  const results: ScaleResult[] = [];
  let h3Version = "unknown";
  let polygonToCellsP95Ms = 0;
  try {
    const extension = await client.query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'h3'");
    h3Version = extension.rows[0]?.extversion ?? "missing";
    await client.query(`CREATE TEMP TABLE gowm_spatial_bench (
      id bigint PRIMARY KEY,
      object_type text NOT NULL,
      status text NOT NULL,
      geometry geometry(Point, 4326) NOT NULL,
      geog geography(Point, 4326) NOT NULL,
      h3_r7 h3index NOT NULL,
      h3_r9 h3index NOT NULL
    ) ON COMMIT PRESERVE ROWS`);
    await client.query("CREATE INDEX gowm_spatial_bench_geometry_gix ON gowm_spatial_bench USING gist (geometry)");
    await client.query("CREATE INDEX gowm_spatial_bench_geog_gix ON gowm_spatial_bench USING gist (geog)");
    await client.query("CREATE INDEX gowm_spatial_bench_h3_r7_idx ON gowm_spatial_bench (h3_r7)");
    await client.query("CREATE INDEX gowm_spatial_bench_h3_r9_idx ON gowm_spatial_bench (h3_r9)");
    const polygonToCells = await samples(30, async () => client.query(
      `SELECT count(*) FROM h3_polygon_to_cells(
         ST_MakeEnvelope(116.38, 39.88, 116.42, 39.92, 4326), 9
       )`
    ));
    polygonToCellsP95Ms = percentile(polygonToCells, 95);
    for (const scale of scales) {
      await client.query("TRUNCATE gowm_spatial_bench");
      const insertStarted = performance.now();
      await client.query(
        `INSERT INTO gowm_spatial_bench (id, object_type, status, geometry, geog, h3_r7, h3_r9)
         SELECT n,
                CASE WHEN n % 5 = 0 THEN 'UGV' ELSE 'Vehicle' END,
                CASE WHEN n % 7 = 0 THEN 'BUSY' ELSE 'AVAILABLE' END,
                p, p::geography, h3_latlng_to_cell(p, 7), h3_latlng_to_cell(p, 9)
         FROM generate_series(1, $1::int) AS n
         CROSS JOIN LATERAL ST_SetSRID(ST_MakePoint(
           116.4 + (((n * 7919) % 10000) - 5000) / 50000.0,
           39.9 + (((n * 104729) % 10000) - 5000) / 50000.0
         ), 4326) AS p`,
        [scale]
      );
      const insertWithH3Ms = Number((performance.now() - insertStarted).toFixed(2));
      await client.query("ANALYZE gowm_spatial_bench");
      const nearby = await samples(30, async () => client.query(
        `SELECT id FROM gowm_spatial_bench
         WHERE ST_DWithin(geog, ST_SetSRID(ST_MakePoint(116.4, 39.9), 4326)::geography, 5000)
           AND object_type = 'UGV' AND status = 'AVAILABLE' LIMIT 10`
      ));
      const within = await samples(30, async () => client.query(
        `SELECT count(*) FROM gowm_spatial_bench
         WHERE ST_Covers(ST_MakeEnvelope(116.38, 39.88, 116.42, 39.92, 4326), geometry)`
      ));
      const nearest = await samples(30, async () => client.query(
        `SELECT id FROM gowm_spatial_bench
         WHERE object_type = 'UGV'
         ORDER BY geog <-> ST_SetSRID(ST_MakePoint(116.4, 39.9), 4326)::geography LIMIT 10`
      ));
      const h3Exact = await samples(30, async () => client.query(
        `SELECT count(*) FROM gowm_spatial_bench
         WHERE h3_r9 = h3_latlng_to_cell(ST_SetSRID(ST_MakePoint(116.4, 39.9), 4326), 9)`
      ));
      const h3Parent = await samples(30, async () => client.query(
        `SELECT count(*) FROM gowm_spatial_bench
         WHERE h3_cell_to_parent(h3_r9, 7) = h3_latlng_to_cell(ST_SetSRID(ST_MakePoint(116.4, 39.9), 4326), 7)`
      ));
      results.push({
        objects: scale,
        insertWithH3Ms,
        nearbyP50Ms: percentile(nearby, 50), nearbyP95Ms: percentile(nearby, 95), nearbyP99Ms: percentile(nearby, 99),
        withinP95Ms: percentile(within, 95), nearestP95Ms: percentile(nearest, 95),
        h3ExactP95Ms: percentile(h3Exact, 95), h3ParentFilterP95Ms: percentile(h3Parent, 95)
      });
    }
  } finally {
    client.release();
    await closeDatabasePool();
  }
  const output = {
    scope: "PostGIS + h3-pg temporary-table benchmark",
    runAt: new Date().toISOString(),
    h3PgVersion: h3Version,
    polygonToCellsP95Ms,
    results
  };
  await mkdir("output/benchmarks", { recursive: true });
  await writeFile("output/benchmarks/postgis-benchmark.json", `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function samples(count: number, action: () => Promise<unknown>): Promise<number[]> {
  await action();
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = performance.now();
    await action();
    values.push(performance.now() - start);
  }
  return values;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number((sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)] ?? 0).toFixed(2));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
