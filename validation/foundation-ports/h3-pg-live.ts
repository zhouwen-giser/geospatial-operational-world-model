import pg from "pg";
import { H3PgLocalAdapter } from "../../packages/integrations/foundation-local/src/index.js";

const databaseUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Pass DATABASE_URL as the first argument or environment variable");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
try {
  const extensions = await client.query<{ extname: string; extversion: string }>(
    "SELECT extname, extversion FROM pg_extension WHERE extname IN ('h3','h3_postgis') ORDER BY extname"
  );
  const h3Version = extensions.rows.find((row) => row.extname === "h3")?.extversion;
  if (!h3Version) throw new Error("h3-pg extension is not installed");

  await client.query("BEGIN READ ONLY");
  const adapter = new H3PgLocalAdapter(client, { h3PgVersion: h3Version });
  const tokyo = await adapter.indexPoints({
    points: [{ longitude: 139.7671, latitude: 35.6812 }],
    resolution: 9
  });
  const beijing = await adapter.projectPoint({ point: { longitude: 116.4, latitude: 39.9 } });
  await client.query("ROLLBACK");

  assertEqual(tokyo.result[0]?.index, "892f5a32d97ffff", "Tokyo R9");
  const expected = {
    "7": "8731aa428ffffff",
    "8": "8831aa4287fffff",
    "9": "8931aa42867ffff",
    "10": "8a31aa428657fff"
  };
  for (const [resolution, cell] of Object.entries(expected)) {
    assertEqual(beijing.result.cells[resolution], cell, `Beijing R${resolution}`);
  }

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    engine: { name: "h3-pg", version: h3Version },
    extensions: extensions.rows,
    operations: [tokyo.receipt.operationId, beijing.receipt.operationId],
    remoteDependency: false,
    writeTransaction: false
  })}\n`);
} finally {
  client.release();
  await pool.end();
}

function assertEqual(actual: string | undefined, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual ?? "missing"}`);
}
