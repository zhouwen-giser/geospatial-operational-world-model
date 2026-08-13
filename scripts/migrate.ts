import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { loadConfig } from "../packages/world-model-core/src/config.js";

const { Pool } = pg;

export async function migrate(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  const directory = resolve(process.cwd(), "database/migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migration (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())");
    for (const file of files) {
      const template = await readFile(resolve(directory, file), "utf8");
      if (!Number.isInteger(config.analysisSrid) || config.analysisSrid <= 0) {
        throw new Error("ANALYSIS_SRID must be a positive integer");
      }
      for (const [name,value] of Object.entries({
        TRACKLET_MAX_TIME_GAP_MS: config.trackletMaxTimeGapMs,
        TRACKLET_MAX_DISTANCE_GAP_M: config.trackletMaxDistanceGapM,
        TRACKLET_MAX_REQUIRED_SPEED_MPS: config.trackletMaxRequiredSpeedMps
      })) {
        if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
      }
      const sql = template
        .replaceAll(":ANALYSIS_SRID", String(config.analysisSrid))
        .replaceAll(":TRACKLET_MAX_TIME_GAP_MS", String(config.trackletMaxTimeGapMs))
        .replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", String(config.trackletMaxDistanceGapM))
        .replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", String(config.trackletMaxRequiredSpeedMps));
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await pool.query<{ checksum: string }>("SELECT checksum FROM schema_migration WHERE version = $1", [file]);
      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${file}`);
        continue;
      }
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migration(version, checksum) VALUES ($1, $2)", [file, checksum]);
      process.stdout.write(`applied ${file}\n`);
    }
    const stasPassword = process.env.STAS_DB_PASSWORD;
    if (stasPassword === undefined || stasPassword.length < 16) {
      throw new Error("STAS_DB_PASSWORD must contain at least 16 characters");
    }
    await pool.query("SELECT set_config('gowm.stas_db_password',$1,false)", [stasPassword]);
    await pool.query(`DO $provision$
      BEGIN
        EXECUTE format('ALTER ROLE stas_app PASSWORD %L',current_setting('gowm.stas_db_password'));
      END
    $provision$`);
    await pool.query("SELECT set_config('gowm.stas_db_password','',false)");
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
