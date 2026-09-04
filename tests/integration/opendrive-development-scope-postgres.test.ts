import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorldRepository } from "../../packages/runtime/src/world-repository.js";
import { SituationRepository } from "../../packages/runtime/src/situation-repository.js";
import { runAdmission } from "../../scripts/opendrive/admit.js";
import { databaseFingerprint, inspectDatabaseIdentity } from "../../scripts/opendrive/admission-safety.js";
import { migrate } from "../../scripts/migrate.js";
import { RepositorySituationReadPort } from "../../services/providers/gowm-situation-provider/src/repository-adapter.js";

const { Pool } = pg;
const adminUrl = process.env.GOWM_OPENDRIVE_DEV_REGRESSION_ADMIN_URL;

describe.skipIf(!adminUrl).sequential("OpenDRIVE development database baseline-scope admission", () => {
  let temporaryRoot = "";
  let artifactDirectory = "";
  let databaseUrl = "";

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    parsed.pathname = "/gowm";
    databaseUrl = parsed.toString();
    temporaryRoot = await mkdtemp(join(tmpdir(), "gowm-opendrive-development-scope-"));
    artifactDirectory = resolve(temporaryRoot, "artifacts");
    await cp(resolve("reports/opendrive-task-network-v0.1/artifacts"), artifactDirectory, { recursive: true });
  });

  afterAll(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function resetDatabase(): Promise<void> {
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query("DROP DATABASE IF EXISTS gowm WITH (FORCE)");
      await admin.query("CREATE DATABASE gowm");
    } finally {
      await admin.end();
    }
    const previous = process.env.DATABASE_URL;
    const previousStasPassword = process.env.STAS_DB_PASSWORD;
    const previousHistoricalWorkerPassword = process.env.HISTORICAL_WORKER_DB_PASSWORD;
    process.env.DATABASE_URL = databaseUrl;
    process.env.STAS_DB_PASSWORD = "opendrive_stas_regression_123";
    process.env.HISTORICAL_WORKER_DB_PASSWORD = "opendrive_history_regression_123";
    try {
      await migrate({ maximumMigrationNumber: 69 });
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      if (previousStasPassword === undefined) delete process.env.STAS_DB_PASSWORD;
      else process.env.STAS_DB_PASSWORD = previousStasPassword;
      if (previousHistoricalWorkerPassword === undefined) delete process.env.HISTORICAL_WORKER_DB_PASSWORD;
      else process.env.HISTORICAL_WORKER_DB_PASSWORD = previousHistoricalWorkerPassword;
    }
  }

  async function admissionEnvironment(): Promise<NodeJS.ProcessEnv> {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const client = await pool.connect();
      try {
        const fingerprint = databaseFingerprint(await inspectDatabaseIdentity(client));
        return {
          GOWM_OPENDRIVE_OUTPUT_ROOT: artifactDirectory,
          GOWM_OPENDRIVE_DATA_SCOPE_KEY: "default",
          GOWM_OPENDRIVE_DATASET_SCOPE_KEY: "airport2-task-network",
          GOWM_OPENDRIVE_GRAPH_KEY: "airport2-task-network-v1",
          GOWM_OPENDRIVE_DATABASE_URL: databaseUrl,
          GOWM_OPENDRIVE_EXPECTED_DB_FINGERPRINT: fingerprint,
          GOWM_OPENDRIVE_ALLOW_DB_MUTATION: "YES",
          GOWM_OPENDRIVE_ALLOW_DEVELOPMENT_DATABASE: "YES",
          GOWM_OPENDRIVE_EXPECTED_COMPOSE_PROJECT: "gowm-opendrive-dev-regression",
          COMPOSE_PROJECT_NAME: "gowm-opendrive-dev-regression"
        };
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }

  async function catalogCounts(): Promise<Record<string, number>> {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const result = await pool.query<Record<string, string>>(`SELECT
        (SELECT count(*)::text FROM data_scope) AS scopes,
        (SELECT count(*)::text FROM spatial_dataset) AS datasets,
        (SELECT count(*)::text FROM spatial_dataset_version) AS dataset_versions,
        (SELECT count(*)::text FROM network_graph) AS graphs,
        (SELECT count(*)::text FROM network_graph_version) AS graph_versions,
        (SELECT count(*)::text FROM network_edge) AS edges,
        (SELECT count(*)::text FROM network_arc) AS arcs,
        (SELECT count(*)::text FROM network_turn_rule) AS turns`);
      return Object.fromEntries(Object.entries(result.rows[0]!).map(([key, value]) => [key, Number(value)]));
    } finally {
      await pool.end();
    }
  }

  it("reuses the unique exact bootstrap scope once and leaves the Situation Provider ready", async () => {
    await resetDatabase();
    const environment = await admissionEnvironment();
    await expect(runAdmission(environment, [artifactDirectory])).resolves.toMatchObject({ status: "PASS" });
    const expected = {
      scopes: 1, datasets: 1, dataset_versions: 1, graphs: 1, graph_versions: 1,
      edges: 244, arcs: 244, turns: 336
    };
    await expect(catalogCounts()).resolves.toEqual(expected);

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      const provider = new RepositorySituationReadPort(
        new SituationRepository(pool), new WorldRepository(pool), pool, "default"
      );
      await expect(provider.readiness()).resolves.toEqual({ ready: true, reasons: [] });
    } finally {
      await pool.end();
    }

    await expect(runAdmission(environment, [artifactDirectory])).resolves.toMatchObject({ status: "FAIL" });
    await expect(catalogCounts()).resolves.toEqual(expected);
  }, 60_000);

  it("rejects an extra scope without creating catalog or graph content", async () => {
    await resetDatabase();
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query("INSERT INTO data_scope(scope_key,operational_domain,description) VALUES('unexpected','TEST','unexpected regression scope')");
    await pool.end();
    await expect(runAdmission(await admissionEnvironment(), [artifactDirectory])).resolves.toMatchObject({ status: "FAIL" });
    await expect(catalogCounts()).resolves.toMatchObject({ scopes: 2, datasets: 0, graphs: 0, graph_versions: 0 });
  }, 60_000);

  it("rejects incorrect bootstrap scope metadata without creating graph content", async () => {
    await resetDatabase();
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query("UPDATE data_scope SET description='wrong metadata' WHERE scope_key='default'");
    await pool.end();
    await expect(runAdmission(await admissionEnvironment(), [artifactDirectory])).resolves.toMatchObject({ status: "FAIL" });
    await expect(catalogCounts()).resolves.toMatchObject({ scopes: 1, datasets: 0, graphs: 0, graph_versions: 0 });
  }, 60_000);

  it("rejects an existing target graph without adding a graph version", async () => {
    await resetDatabase();
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`WITH dataset AS (
      INSERT INTO spatial_dataset(reference_key,data_scope_key,dataset_scope_key,dataset_key,name)
      VALUES('wrf_00000000000000000000000000000001','default','collision-fixture','unrelated','collision fixture')
      RETURNING dataset_id
    ) INSERT INTO network_graph(data_scope_key,dataset_scope_key,dataset_id,graph_key,description)
      SELECT 'default','collision-fixture',dataset_id,'airport2-task-network-v1','pre-existing graph collision'
      FROM dataset`);
    await pool.end();
    await expect(runAdmission(await admissionEnvironment(), [artifactDirectory])).resolves.toMatchObject({ status: "FAIL" });
    await expect(catalogCounts()).resolves.toMatchObject({ scopes: 1, datasets: 1, graphs: 1, graph_versions: 0 });
  }, 60_000);
});
