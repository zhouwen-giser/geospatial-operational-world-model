import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;
const FIXTURE_ID = "gowm-wsgs-sample-world";
const OUTPUT_DIRECTORY = resolve(process.env.SAMPLE_WORLD_OUTPUT_DIRECTORY ?? ".runtime/wsgs-sample/output");
const BASELINE_PATH = resolve(OUTPUT_DIRECTORY, "UPGRADE_062_BASELINE.json");
const REPORT_PATH = resolve(OUTPUT_DIRECTORY, "UPGRADE_062_REPORT.json");

export async function probeReferenceGeometryUpgrade(
  phase: "baseline" | "upgraded",
  environment: NodeJS.ProcessEnv = process.env
): Promise<Record<string, unknown>> {
  const candidateCommit = requiredMatch(environment.GOWM_QUALIFICATION_CANDIDATE_SHA, /^[0-9a-f]{40}$/u,
    "GOWM_QUALIFICATION_CANDIDATE_SHA");
  const expectedDatabase = requiredMatch(environment.POSTGRES_DB,
    /^gowm_wsgs_sample_q_[a-z0-9_]{1,48}$/u, "POSTGRES_DB");
  const databaseUrl = required(environment.DATABASE_URL);
  if (new URL(databaseUrl).pathname !== `/${expectedDatabase}`) {
    throw new Error("Upgrade probe database URL differs from the bounded qualification database");
  }
  const preflightBytes = await readFile(resolve(OUTPUT_DIRECTORY, "QUALIFICATION_PREFLIGHT.json"));
  const preflight = JSON.parse(preflightBytes.toString("utf8")) as Record<string, any>;
  assertQualificationPreflight(preflight, candidateCommit);
  const pool = new Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 120_000 });
  try {
    const database = await pool.query<{ database_name: string }>("SELECT current_database() AS database_name");
    if (database.rows[0]?.database_name !== expectedDatabase) throw new Error("Upgrade probe connected to an unexpected database");
    const marker = await pool.query<{ fixture_id: string; schema_version: string; allowed_data_scopes: string[] }>(`
      SELECT fixture_id,schema_version,allowed_data_scopes
      FROM gowm_sample_fixture.instance_marker
    `);
    if (marker.rows.length !== 1 || marker.rows[0]?.fixture_id !== FIXTURE_ID ||
        marker.rows[0]?.schema_version !== "gowm-wsgs-sample-world/1.0" ||
        JSON.stringify(marker.rows[0]?.allowed_data_scopes) !== JSON.stringify(["wsgs-demo", "wsgs-hidden"])) {
      throw new Error("Upgrade probe fixture marker mismatch");
    }

    const migrations = await pool.query<{ version: string; checksum: string }>(`
      SELECT version,checksum FROM schema_migration ORDER BY version
    `);
    const expectedCount = phase === "baseline" ? 61 : 62;
    if (migrations.rows.length !== expectedCount ||
        migrations.rows.some(({ version }, index) => Number.parseInt(version.slice(0, 3), 10) !== index + 1)) {
      throw new Error(`Upgrade probe expected ${expectedCount} ordered migrations`);
    }
    const migration062 = migrations.rows.find(({ version }) => version === "062_reference_geometry_composability.sql");
    if ((phase === "baseline") === (migration062 !== undefined)) {
      throw new Error("Migration 062 presence does not match the requested upgrade phase");
    }

    const zone = await pool.query<{
      reference_key: string;
      feature_version: string;
      descriptor_version: string;
      object_version: string | null;
      geometry_type: string;
      crs: number;
      bbox_matches: boolean;
    }>(`
      SELECT identity.reference_key,version.version AS feature_version,
             descriptor.descriptor_version::text AS descriptor_version,
             descriptor.object_version,GeometryType(version.geometry) AS geometry_type,
             ST_SRID(version.geometry) AS crs,
             ST_XMin(Box2D(version.geometry))=ST_XMin(ST_Envelope(version.geometry))
               AND ST_YMin(Box2D(version.geometry))=ST_YMin(ST_Envelope(version.geometry))
               AND ST_XMax(Box2D(version.geometry))=ST_XMax(ST_Envelope(version.geometry))
               AND ST_YMax(Box2D(version.geometry))=ST_YMax(ST_Envelope(version.geometry)) AS bbox_matches
      FROM spatial_feature_identity identity
      JOIN spatial_feature_version version USING(feature_id)
      JOIN LATERAL (
        SELECT candidate.* FROM world_reference_descriptor_version candidate
        WHERE candidate.reference_key=identity.reference_key
        ORDER BY candidate.descriptor_version DESC LIMIT 1
      ) descriptor ON true
      WHERE identity.data_scope_key='wsgs-demo'
        AND identity.dataset_scope_key='wsgs-demo-main'
        AND version.properties->>'fixtureFeatureKey'='zone-a'
        AND (version.retired_at IS NULL OR version.retired_at>statement_timestamp())
      ORDER BY version.published_at DESC,version.version DESC
      LIMIT 1
    `);
    if (zone.rows.length !== 1) throw new Error("Upgrade probe cannot find the unique current A-zone feature");
    const zoneRow = zone.rows[0]!;
    if (zoneRow.object_version !== zoneRow.feature_version || zoneRow.crs !== 4326 ||
        !["POLYGON", "MULTIPOLYGON"].includes(zoneRow.geometry_type) || !zoneRow.bbox_matches) {
      throw new Error("A-zone immutable descriptor or geometry invariants are invalid");
    }

    await pool.query("SELECT set_config('gowm.data_scope_key','wsgs-demo',false)");
    await pool.query("SELECT set_config('gowm.dataset_scope_key','wsgs-demo-main',false)");
    const unified = await pool.query<{ world_objects: string; zone_features: string }>(`
      SELECT count(*) FILTER (WHERE reference_key_value->>'kind'='WORLD_OBJECT')::text AS world_objects,
             count(*) FILTER (WHERE reference_key=$1)::text AS zone_features
      FROM gowm_evidence_v1.current_geometry
    `, [zoneRow.reference_key]);
    if (Number(unified.rows[0]?.world_objects) < 1) throw new Error("WORLD_OBJECT current_geometry regression failed");

    const loadReport = JSON.parse(await readFile(resolve(OUTPUT_DIRECTORY, "LOAD_REPORT.json"), "utf8")) as Record<string, any>;
    const loadEvidence = JSON.parse(await readFile(resolve(OUTPUT_DIRECTORY, "LOAD_EVIDENCE.json"), "utf8")) as Record<string, any>;
    if (loadReport.status !== "PASS" || loadEvidence.realizationId === undefined || loadEvidence.loadedStateHash === undefined) {
      throw new Error("Upgrade probe load evidence is missing");
    }
    const common = {
      candidateCommit,
      databaseIdentityHash: digest(expectedDatabase),
      migrationCount: migrations.rows.length,
      migrationSetHash: digest(migrations.rows),
      sourceFixtureHash: loadReport.sourceFixtureHash,
      realizationHash: loadReport.realizationHash,
      realizationId: loadEvidence.realizationId,
      loadedStateHash: loadEvidence.loadedStateHash,
      qualificationPreflightHash: preflight.evidenceHash,
      qualificationPreflightArtifactSha256: `sha256:${createHash("sha256").update(preflightBytes).digest("hex")}`,
      zoneReferenceHash: digest(zoneRow.reference_key),
      descriptorVersionHash: digest(zoneRow.descriptor_version),
      featureVersionHash: digest(zoneRow.feature_version),
      descriptorObjectVersionMatchesFeature: true,
      geometryType: zoneRow.geometry_type,
      crs: `EPSG:${zoneRow.crs}`,
      bboxDerivedFromGeometry: zoneRow.bbox_matches,
      worldObjectCurrentGeometryCount: Number(unified.rows[0]?.world_objects)
    };

    if (phase === "baseline") {
      if (Number(unified.rows[0]?.zone_features) !== 0) {
        throw new Error("Frozen 001-061 baseline unexpectedly realizes A-zone through current_geometry");
      }
      const report = {
        schemaVersion: "1.0",
        phase,
        ...common,
        migration062Applied: false,
        baselineDivergence: {
          descriptorPresent: true,
          descriptorCurrentObjectVersion: true,
          sameReferenceGeometryRows: 0,
          defectReproduced: true
        },
        status: "PASS"
      };
      await writeFile(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      return report;
    }

    if (!migration062 || Number(unified.rows[0]?.zone_features) !== 1) {
      throw new Error("Upgraded database does not realize the same A-zone reference");
    }
    const catalogRows = await pool.query<{
      reference_version: string;
      feature_version: string;
      geometry_type: string;
      crs: string;
      content_hash: string;
    }>(`
      SELECT reference_version,feature_version,geometry_type,crs,content_hash
      FROM gowm_evidence_v1.catalog_feature_geometry
      WHERE reference_key=$1 ORDER BY reference_version
    `, [zoneRow.reference_key]);
    if (!catalogRows.rows.some((row) => row.reference_version === zoneRow.descriptor_version &&
        row.feature_version === zoneRow.feature_version) ||
        !catalogRows.rows.some((row) => row.reference_version === zoneRow.feature_version &&
        row.feature_version === zoneRow.feature_version)) {
      throw new Error("Descriptor and immutable feature pins are not both composable");
    }
    const inside = await pool.query<{ count: string }>(`
      SELECT count(*)::text
      FROM spatial_feature_version zone
      JOIN spatial_feature_identity zone_identity USING(feature_id)
      JOIN world_object object_record ON object_record.data_scope_key=zone_identity.data_scope_key
      JOIN world_object_geometry object_geometry ON object_geometry.object_id=object_record.id
      WHERE zone_identity.reference_key=$1
        AND zone.version=$2
        AND object_record.properties->>'fixtureObjectKey'='ugv-002'
        AND ST_Covers(zone.geometry,object_geometry.geometry)
    `, [zoneRow.reference_key, zoneRow.feature_version]);
    if (Number(inside.rows[0]?.count) < 1) throw new Error("A-zone does not cover the canonical test vehicle");

    const scopeChecks = await verifyScopeIsolation(pool, zoneRow.reference_key);
    const invalidGeometryRejected = await verifyInvalidGeometryRejected(pool, zoneRow.reference_key);
    const providerReadOnly = await verifyProviderReadOnly(pool);
    const snapshot = await verifySnapshotAdvances(pool, zoneRow.reference_key);
    const baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as Record<string, any>;
    if (baseline.candidateCommit !== candidateCommit || baseline.loadedStateHash !== loadEvidence.loadedStateHash ||
        baseline.zoneReferenceHash !== digest(zoneRow.reference_key) || baseline.baselineDivergence?.defectReproduced !== true) {
      throw new Error("Baseline and upgraded observations are not from the same candidate/database realization");
    }
    const assertionCount = Number(requiredMatch(environment.GOWM_V064_DB_ASSERTION_COUNT, /^45$/u,
      "GOWM_V064_DB_ASSERTION_COUNT"));
    const report = {
      schemaVersion: "1.0",
      phase,
      ...common,
      baselineEvidenceHash: digest(baseline),
      migration062Applied: true,
      migration062: {
        version: migration062.version,
        executedSqlChecksum: `sha256:${migration062.checksum}`
      },
      sameDatabaseUpgrade: baseline.databaseIdentityHash === digest(expectedDatabase),
      descriptorPinComposes: true,
      immutableFeaturePinComposes: true,
      currentFeatureGeometryRows: Number(unified.rows[0]?.zone_features),
      catalogFeatureGeometryPinRows: catalogRows.rows.length,
      expectedVehicleCovered: true,
      invalidGeometryRejected,
      scopeChecks,
      providerReadOnly,
      snapshot,
      databaseAssertions: { filesPassed: assertionCount, total: 45, status: "PASS" },
      status: "PASS"
    };
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } finally {
    await pool.end();
  }
}

function assertQualificationPreflight(preflight: Record<string, any>, candidateCommit: string): void {
  const core = { ...preflight };
  delete core.evidenceHash;
  if (preflight.schemaVersion !== "1.0" || preflight.targetVersion !== "0.6.4" ||
      preflight.purpose !== "upgrade" || preflight.candidateCommit !== candidateCommit ||
      !/^q-[a-z0-9][a-z0-9-]{0,47}$/u.test(String(preflight.runtimeInstanceId)) ||
      preflight.status !== "PASS" || preflight.git?.remoteCount !== 0 ||
      preflight.git?.sourceContextClean !== true ||
      preflight.observedAbsent?.composeProjectContainers !== 0 ||
      preflight.observedAbsent?.databaseVolumeAbsent !== true ||
      preflight.observedAbsent?.runtimeVolumeAbsent !== true ||
      preflight.observedAbsent?.composeNetworksAbsent !== true ||
      preflight.observedAbsent?.composeNetworkCount !== 3 ||
      !/^sha256:[0-9a-f]{64}$/u.test(String(preflight.resourceIdentityHash)) ||
      !Number.isFinite(Date.parse(String(preflight.generatedAt))) ||
      preflight.evidenceHash !== digest(core)) {
    throw new Error("Upgrade qualification preflight does not prove fresh q-* resource absence");
  }
}

async function verifyScopeIsolation(pool: pg.Pool, zoneReference: string): Promise<Record<string, unknown>> {
  await pool.query("SELECT set_config('gowm.data_scope_key','wsgs-demo',false)");
  await pool.query("SELECT set_config('gowm.dataset_scope_key','wsgs-demo-main',false)");
  const authorized = await countRows(pool, zoneReference);
  await pool.query("SELECT set_config('gowm.dataset_scope_key','missing',false)");
  const wrongDataset = await countRows(pool, zoneReference);
  await pool.query("SELECT set_config('gowm.data_scope_key','wsgs-hidden',false)");
  await pool.query("SELECT set_config('gowm.dataset_scope_key','wsgs-hidden-main',false)");
  const wrongData = await countRows(pool, zoneReference);
  await pool.query("RESET gowm.data_scope_key");
  await pool.query("RESET gowm.dataset_scope_key");
  const absent = await countRows(pool, zoneReference);
  if (authorized < 1 || wrongDataset !== 0 || wrongData !== 0 || absent !== 0) {
    throw new Error("Feature geometry scope isolation failed");
  }
  return { authorizedRows: authorized, wrongDatasetRows: wrongDataset, wrongDataRows: wrongData, absentScopeRows: absent, status: "PASS" };
}

async function countRows(pool: pg.Pool, reference: string): Promise<number> {
  const result = await pool.query<{ count: string }>(`
    SELECT count(*)::text FROM gowm_evidence_v1.catalog_feature_geometry WHERE reference_key=$1
  `, [reference]);
  return Number(result.rows[0]?.count);
}

async function verifyInvalidGeometryRejected(pool: pg.Pool, zoneReference: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO spatial_feature_version(
          feature_id,layer_id,layer_version_id,version,geometry,properties,
          source_feature_id,content_hash,published_at
        )
        SELECT identity.feature_id,identity.layer_id,current_version.layer_version_id,
               'qualification-invalid',ST_GeomFromText('POLYGON((0 0,1 1,1 0,0 1,0 0))',4326),
               '{"qualification":true}'::jsonb,'qualification-invalid',
               'sha256:'||repeat('f',64),clock_timestamp()
        FROM spatial_feature_identity identity
        JOIN LATERAL (
          SELECT version.* FROM spatial_feature_version version
          WHERE version.feature_id=identity.feature_id
          ORDER BY version.published_at DESC,version.version DESC LIMIT 1
        ) current_version ON true
        WHERE identity.reference_key=$1
      `, [zoneReference]);
      throw new Error("Authoritative feature store accepted invalid geometry");
    } catch (error) {
      if (error instanceof Error && error.message === "Authoritative feature store accepted invalid geometry") throw error;
      const databaseError = error as { code?: string; constraint?: string };
      if (databaseError.code !== "23514" ||
          databaseError.constraint !== "spatial_feature_version_geometry_check") {
        throw error;
      }
      return true;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

async function verifyProviderReadOnly(pool: pg.Pool): Promise<Record<string, unknown>> {
  const privileges = await pool.query<{
    evidence_base_read: boolean;
    spatial_base_read: boolean;
    evidence_contract_read: boolean;
    spatial_contract_read: boolean;
  }>(`
    SELECT
      has_table_privilege('gowm_evidence_reader','public.spatial_feature_version','SELECT') AS evidence_base_read,
      has_table_privilege('spatial_provider','public.spatial_feature_version','SELECT') AS spatial_base_read,
      has_table_privilege('gowm_evidence_reader','gowm_evidence_v1.catalog_feature_geometry','SELECT') AS evidence_contract_read,
      has_table_privilege('spatial_provider','gowm_spatial_v1.catalog_feature','SELECT') AS spatial_contract_read
  `);
  const row = privileges.rows[0]!;
  if (row.evidence_base_read || row.spatial_base_read || !row.evidence_contract_read || !row.spatial_contract_read) {
    throw new Error("Provider base-table/read-contract privileges are invalid");
  }
  const client = await pool.connect();
  let dmlRejected = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE gowm_evidence_reader");
    try {
      await client.query("INSERT INTO public.data_scope(scope_key,operational_domain) VALUES ('qualification-write-probe','TEST')");
    } catch (error) {
      const databaseError = error as { code?: string };
      if (databaseError.code !== "42501") throw error;
      dmlRejected = true;
    }
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
  }
  if (!dmlRejected) throw new Error("Read-only Provider role accepted a Foundation write");
  return { baseTableSelect: false, contractViewSelect: true, dmlRejected: true, status: "PASS" };
}

async function verifySnapshotAdvances(pool: pg.Pool, zoneReference: string): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT gowm_evidence_v1.set_data_scope('wsgs-demo')");
    await client.query("SELECT set_config('gowm.dataset_scope_key','wsgs-demo-main',true)");
    const before = await client.query<{ value: string }>("SELECT catalog_snapshot_version AS value FROM gowm_spatial_v1.catalog_snapshot");
    await client.query(`
      INSERT INTO spatial_feature_version(
        feature_id,layer_id,layer_version_id,version,geometry,properties,
        source_feature_id,content_hash,published_at
      )
      SELECT identity.feature_id,identity.layer_id,current_version.layer_version_id,
             'qualification-snapshot-v2',ST_Translate(current_version.geometry,0.000001,0.000001),
             jsonb_build_object('fixtureFeatureKey','zone-a','qualification',true),
             'qualification-snapshot-v2','sha256:'||repeat('e',64),clock_timestamp()+interval '1 second'
      FROM spatial_feature_identity identity
      JOIN LATERAL (
        SELECT version.* FROM spatial_feature_version version
        WHERE version.feature_id=identity.feature_id
        ORDER BY version.published_at DESC,version.version DESC LIMIT 1
      ) current_version ON true
      WHERE identity.reference_key=$1
    `, [zoneReference]);
    const after = await client.query<{ value: string }>("SELECT catalog_snapshot_version AS value FROM gowm_spatial_v1.catalog_snapshot");
    if (!before.rows[0]?.value || !after.rows[0]?.value || before.rows[0].value === after.rows[0].value) {
      throw new Error("Catalog snapshot did not advance after an immutable feature version change");
    }
    return { beforeHash: digest(before.rows[0].value), afterHash: digest(after.rows[0].value), changed: true, status: "PASS" };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function required(value: string | undefined): string {
  if (!value?.trim()) throw new Error("DATABASE_URL is required");
  return value;
}
function requiredMatch(value: string | undefined, pattern: RegExp, name: string): string {
  if (!value?.trim() || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

if (process.argv[1]?.endsWith("gowm-v064-upgrade-probe.js")) {
  const phase = process.argv[2];
  if (phase !== "baseline" && phase !== "upgraded") throw new Error("Upgrade probe phase must be baseline or upgraded");
  probeReferenceGeometryUpgrade(phase).then(
    (report) => process.stdout.write(`GOWM_V064_UPGRADE_${phase.toUpperCase()}_PASS hash=${digest(report)}\n`),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
