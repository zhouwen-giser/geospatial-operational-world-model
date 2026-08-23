import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    assertDistinctRuntimePasswords();
    await provisionRuntimeLogin(pool, "gowm_gateway_service", "GATEWAY_DB_PASSWORD", "gowm.gateway_db_password");
    await provisionRuntimeLogin(pool, "gowm_gateway_registry_service", "GATEWAY_REGISTRY_DB_PASSWORD", "gowm.gateway_registry_db_password");
    await provisionRuntimeLogin(pool, "gowm_spatial_service", "SPATIAL_DB_PASSWORD", "gowm.spatial_db_password");
    await provisionRuntimeLogin(pool, "gowm_situation_service", "SITUATION_DB_PASSWORD", "gowm.situation_db_password");
  } finally {
    await pool.end();
  }
}

async function provisionRuntimeLogin(
  pool: pg.Pool,
  role: "gowm_gateway_service" | "gowm_gateway_registry_service" | "gowm_spatial_service" | "gowm_situation_service",
  environmentName: string,
  settingName: string
): Promise<void> {
  const password = process.env[environmentName];
  if (password === undefined) return;
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(password)) {
    throw new Error(`${environmentName} must contain 32-128 URL-safe characters`);
  }
  await pool.query("SELECT set_config($1,$2,false)", [settingName, password]);
  try {
    await pool.query(`DO $provision$
      BEGIN
        EXECUTE format('ALTER ROLE ${role} LOGIN PASSWORD %L',current_setting('${settingName}'));
      END
    $provision$`);
  } finally {
    await pool.query("SELECT set_config($1,'',false)", [settingName]);
  }
}

function assertDistinctRuntimePasswords(): void {
  const names = ["GATEWAY_DB_PASSWORD", "GATEWAY_REGISTRY_DB_PASSWORD", "SPATIAL_DB_PASSWORD", "SITUATION_DB_PASSWORD"];
  const configured = names.map((name) => process.env[name]).filter((value): value is string => value !== undefined);
  if (new Set(configured).size !== configured.length) throw new Error("capability runtime database passwords must be distinct");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  migrate().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
