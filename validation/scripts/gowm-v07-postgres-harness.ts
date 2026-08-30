import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface V07DatabaseEvidence {
  migrationCount: number;
  migrationHead: string;
  postgresVersion: string;
  postgisVersion: string;
  mobilityDbVersion: string;
}

export interface V07UpgradeDatabaseEvidence extends V07DatabaseEvidence {
  upgradeBaseMigrationCount: number;
  upgradeBaseHead: string;
}

export async function withMigratedV07Database<T>(
  label: string,
  action: (databaseUrl: string, evidence: V07DatabaseEvidence, runId: string) => Promise<T>
): Promise<T> {
  const reusedUrl = process.env.GOWM_V07_REUSE_DATABASE_URL;
  if (reusedUrl !== undefined && reusedUrl.length > 0) {
    const runId = randomUUID().replaceAll("-", "").slice(0, 20);
    const database = new pg.Pool({ connectionString: reusedUrl, max: 1 });
    try {
      return await action(reusedUrl, await inspectMigratedDatabase(database), runId);
    } finally {
      await database.end();
    }
  }
  const sourceUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (sourceUrl === undefined || sourceUrl.length === 0) {
    throw new Error("DATABASE_ADMIN_URL or DATABASE_URL is required for the real PostgreSQL v0.7 gate");
  }
  const runId = randomUUID().replaceAll("-", "").slice(0, 20);
  const databaseName = `gowm_v07_${label}_${runId}`;
  if (!/^[a-z0-9_]+$/u.test(databaseName)) throw new Error("invalid ephemeral database name");
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;
  const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const database = new pg.Pool({ connectionString: targetUrl.toString(), max: 1 });
    try {
      const evidence = await applyMigrations(database);
      return await action(targetUrl.toString(), evidence, runId);
    } finally {
      await database.end();
    }
  } finally {
    if (created) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    }
    await admin.end();
  }
}

export async function runVitest(
  files: string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const vitest = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
  await runProcess(process.execPath, [vitest, "run", ...files, "--reporter=verbose"], environment);
}

export async function runNode(
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await runProcess(process.execPath, arguments_, environment);
}

async function runProcess(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`v0.7 gate child process failed (exit=${String(code)}, signal=${String(signal)})`));
    });
  });
}

async function migrationFiles(): Promise<string[]> {
  return (await readdir(resolve(repositoryRoot, "database/migrations")))
    .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
    .sort();
}

async function applyMigrations(
  pool: pg.Pool,
  files: readonly string[] | undefined = undefined,
  expectedHead = "067_historical_trajectory_contract.sql"
): Promise<V07DatabaseEvidence> {
  const selectedFiles = files ?? await migrationFiles();
  const migrationDirectory = resolve(repositoryRoot, "database/migrations");
  const migrationHead = selectedFiles.at(-1);
  if (migrationHead !== expectedHead) {
    throw new Error(`unexpected v0.7 migration head: ${String(migrationHead)}`);
  }
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migration(
       version text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
     )`
  );
  for (const file of selectedFiles) {
    const template = await readFile(resolve(migrationDirectory, file), "utf8");
    const sql = template
      .replaceAll(":ANALYSIS_SRID", "32650")
      .replaceAll(":TRACKLET_MAX_TIME_GAP_MS", "10000")
      .replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", "250")
      .replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", "80");
    const checksum = createHash("sha256").update(sql).digest("hex");
    await pool.query(sql);
    await pool.query(
      "INSERT INTO schema_migration(version, checksum) VALUES ($1, $2)",
      [file, checksum]
    );
  }
  return inspectMigratedDatabase(pool, expectedHead);
}

export async function withUpgradedV07Database<T>(
  label: string,
  action: (databaseUrl: string, evidence: V07UpgradeDatabaseEvidence, runId: string) => Promise<T>
): Promise<T> {
  const sourceUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (sourceUrl === undefined || sourceUrl.length === 0) {
    throw new Error("DATABASE_ADMIN_URL or DATABASE_URL is required for the real PostgreSQL v0.7 upgrade gate");
  }
  const runId = randomUUID().replaceAll("-", "").slice(0, 20);
  const databaseName = `gowm_v07_upgrade_${label}_${runId}`;
  if (!/^[a-z0-9_]+$/u.test(databaseName)) throw new Error("invalid ephemeral upgrade database name");
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;
  const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const database = new pg.Pool({ connectionString: targetUrl.toString(), max: 1 });
    try {
      const files = await migrationFiles();
      const baseHead = "064_analysis_resource_inputs.sql";
      const base = await applyMigrations(
        database,
        files.filter((file) => file <= baseHead),
        baseHead
      );
      const upgraded = await applyMigrations(
        database,
        files.filter((file) => file > baseHead),
        "067_historical_trajectory_contract.sql"
      );
      return await action(targetUrl.toString(), {
        ...upgraded,
        upgradeBaseMigrationCount: base.migrationCount,
        upgradeBaseHead: base.migrationHead
      }, runId);
    } finally {
      await database.end();
    }
  } finally {
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
}

async function inspectMigratedDatabase(
  pool: pg.Pool,
  expectedHead = "067_historical_trajectory_contract.sql"
): Promise<V07DatabaseEvidence> {
  const migration = await pool.query<{ migration_count: number; migration_head: string }>(
    `SELECT count(*)::integer AS migration_count, max(version) AS migration_head
     FROM public.schema_migration`
  );
  const migrationRow = migration.rows[0];
  if (migrationRow === undefined
      || migrationRow.migration_head !== expectedHead) {
    throw new Error(`unexpected v0.7 migration head: ${String(migrationRow?.migration_head)}`);
  }
  const versions = await pool.query<{
    postgres_version: string;
    postgis_version: string;
    mobilitydb_version: string;
  }>(
    `SELECT current_setting('server_version') AS postgres_version,
            postgis_lib_version() AS postgis_version,
            mobilitydb_version() AS mobilitydb_version`
  );
  const version = versions.rows[0];
  if (version === undefined) throw new Error("database did not return extension versions");
  return {
    migrationCount: migrationRow.migration_count,
    migrationHead: migrationRow.migration_head,
    postgresVersion: version.postgres_version,
    postgisVersion: version.postgis_version,
    mobilityDbVersion: version.mobilitydb_version
  };
}
