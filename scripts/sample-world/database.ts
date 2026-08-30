import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { normalizeObservationInput, canonicalJson } from "../../packages/observation-model/src/canonical.js";
import { ObservationRepository } from "../../packages/runtime/src/observation-repository.js";
import { ProjectionProcessor } from "../../packages/runtime/src/projection.js";
import { compareUnicodeCodePoints, validateAgainstSchema } from "../../packages/platform/contract-runtime/src/index.js";
import { realizeSampleWorld, type SampleWorldRealization } from "./model.js";

const { Pool } = pg;
const FIXTURE_ID = "gowm-wsgs-sample-world";
const FIXTURE_VERSION = "1.0.0";
const FIXTURE_SCHEMA_VERSION = "gowm-wsgs-sample-world/1.0";
const SCOPES = ["wsgs-demo", "wsgs-hidden"] as const;
const SAMPLE_DATABASE_NAME = /^gowm_wsgs_sample(?:_q_[a-z0-9](?:[a-z0-9_]{0,29}[a-z0-9])?)?$/u;
const SAMPLE_RUNTIME_INSTANCE_ID = /^(?:shared|q-[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?)$/u;

type JsonObject = Record<string, unknown>;
type AnyRecord = Record<string, any>;

const SAMPLE_FAULT_STAGES = [
  "catalog",
  "objects",
  "observation-insert",
  "projection",
  "search-projection"
] as const;

type SampleFaultStage = typeof SAMPLE_FAULT_STAGES[number];

interface SampleFaultInjection {
  readonly stage: SampleFaultStage;
  readonly afterCount: number;
  observedCount: number;
  triggered: boolean;
}

export interface SampleObservationRecordIdentity {
  observationKey: string;
  sourceRecordKey: string;
  rawReference: string;
}

export function sampleObservationRecordIdentity(item: JsonObject): SampleObservationRecordIdentity {
  const observationKey = item.observationKey;
  const sourceRecordKey = item.sourceRecordKey ?? observationKey;
  if (typeof observationKey !== "string" || observationKey.length === 0) {
    throw new Error("Sample observation requires a non-empty observationKey");
  }
  if (typeof sourceRecordKey !== "string" || sourceRecordKey.length === 0) {
    throw new Error("Sample observation requires a non-empty sourceRecordKey");
  }
  return {
    observationKey,
    sourceRecordKey,
    rawReference: `sample://${FIXTURE_ID}/observation/${encodeURIComponent(observationKey)}`
  };
}

export interface SampleLoadReport {
  schemaVersion: "1.0";
  fixtureId: string;
  fixtureVersion: string;
  databaseMarker: string;
  sourceFixtureHash: string;
  realizationHash: string;
  idempotent: true;
  status: "PASS";
  counts: Record<string, number>;
}

export async function loadSampleWorldDatabase(options: {
  connectionString?: string;
  epoch?: string;
  seed?: string;
  outputDirectory?: string;
} = {}): Promise<SampleLoadReport> {
  const connectionString = options.connectionString ?? required("SAMPLE_LOADER_DATABASE_URL");
  const databaseName = assertSampleDatabaseConnection(connectionString, process.env.POSTGRES_DB);
  process.env.DATABASE_URL = connectionString;
  const epoch = normalizedEpoch(options.epoch ?? required("SAMPLE_WORLD_EPOCH"));
  const realization = await realizeSampleWorld({
    epoch,
    seed: options.seed ?? process.env.SAMPLE_WORLD_SEED ?? "gowm-wsgs-sample-world-v1",
    sourceRoot: process.env.SAMPLE_WORLD_SOURCE_ROOT ?? "test-data/wsgs-sample-world/v1"
  });
  const outputDirectory = resolve(options.outputDirectory ?? process.env.SAMPLE_WORLD_OUTPUT_DIRECTORY ?? ".runtime/wsgs-sample/output");
  const pool = new Pool({ connectionString, max: 4 });
  try {
    await assertMarker(pool, databaseName);
    const beforeCounts = await fixtureCounts(pool);
    const initialFixtureWasEmpty = fixtureIsEmpty(beforeCounts);
    const fault = sampleFaultInjectionFromEnvironment();
    if (fault && !initialFixtureWasEmpty) {
      throw new Error("SAMPLE_WORLD_FAULT_AFTER_STAGE is allowed only for an empty first-load fixture");
    }
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await ensureSampleScopes(client as unknown as pg.Pool);
        await loadReferenceIdentities(client as unknown as pg.Pool, realization);
        await loadCatalog(client as unknown as pg.Pool, realization);
        injectSampleFault(fault, "catalog");
        await loadObjectsAndReferences(client as unknown as pg.Pool, realization);
        injectSampleFault(fault, "objects");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const projectionWorldVersions = await loadObservations(pool, realization, "v1", fault);
      await bindWorldObjectDescriptors(pool, realization);
      for (const scope of SCOPES) {
        await pool.query("SELECT rebuild_reference_search_projection($1)", [scope]);
        injectSampleFault(fault, "search-projection");
      }
      if (fault) {
        throw Object.assign(
          new Error(`Configured sample-world fault point was not reached: ${fault.stage} count ${fault.afterCount}`),
          { code: "SAMPLE_WORLD_FAULT_NOT_REACHED" }
        );
      }
      const firstState = await sampleState(pool);
      const firstStateHash = sha256(canonicalJson(firstState));
      const firstCounts = await fixtureCounts(pool);
      assertExpectedCounts(firstCounts);

      await loadCatalog(pool, realization);
      await loadObjectsAndReferences(pool, realization);
      const repeatProjectionWorldVersions = await loadObservations(pool, realization, "v1");
      await bindWorldObjectDescriptors(pool, realization);
      for (const scope of SCOPES) await pool.query("SELECT rebuild_reference_search_projection($1)", [scope]);
      const repeatedState = await sampleState(pool);
      const repeatedStateHash = sha256(canonicalJson(repeatedState));
      const counts = await fixtureCounts(pool);
      assertExpectedCounts(counts);
      if (firstStateHash !== repeatedStateHash || canonicalJson(firstCounts) !== canonicalJson(counts)) {
        throw new Error("Repeated fixture load changed the published sample state");
      }
      const report: SampleLoadReport = {
        schemaVersion: "1.0",
        fixtureId: FIXTURE_ID,
        fixtureVersion: FIXTURE_VERSION,
        databaseMarker: sampleDatabaseMarker(databaseName),
        sourceFixtureHash: String((realization as AnyRecord).fixture.sourceFixtureHash),
        realizationHash: String((realization as AnyRecord).fixture.realizationHash),
        idempotent: true,
        status: "PASS",
        counts
      };
      await mkdir(outputDirectory, { recursive: true });
      await validateSampleArtifact("sample-world-load-report.schema.json", report);
      await writeCanonical(resolve(outputDirectory, "LOAD_REPORT.json"), report);
      await writeCanonical(resolve(outputDirectory, "LOAD_EVIDENCE.json"), {
        schemaVersion: "1.0",
        realizationId: String((realization as AnyRecord).fixture.realizationId),
        loadedStateHash: repeatedStateHash,
        projectionWorldVersions,
        repeatProjectionWorldVersions,
        idempotent: true,
        generatedAt: epoch
      });
      await writeCanonical(resolve(outputDirectory, "SAMPLE_REFERENCE_MAP.json"), await realizedReferenceMap(pool, realization));
      process.stdout.write(`SAMPLE_WORLD_DATA_READY stateHash=${repeatedStateHash} objects=${counts.objects} features=${counts.features}\n`);
      return report;
    } catch (error) {
      if (!initialFixtureWasEmpty) throw error;
      throw await compensateFailedInitialLoad(pool, error, beforeCounts, outputDirectory, epoch, fault);
    }
  } finally {
    await pool.end();
  }
}

async function validateSampleArtifact(schemaFile: string, value: unknown): Promise<void> {
  const schemaPath = resolve("contracts/wsgs-sample-world/v1", schemaFile);
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;
  const validation = validateAgainstSchema(schema, value, { schemaName: schemaFile });
  if (!validation.valid) {
    throw new Error(`${schemaFile} validation failed: ${JSON.stringify(validation.issues)}`);
  }
}

export function parseSampleWorldFaultInjection(
  environment: Readonly<Record<string, string | undefined>> = process.env
): SampleFaultInjection | undefined {
  const configuredStage = environment.SAMPLE_WORLD_FAULT_AFTER_STAGE?.trim();
  const configuredCount = environment.SAMPLE_WORLD_FAULT_AFTER_COUNT?.trim();
  if (!configuredStage) {
    if (configuredCount) throw new Error("SAMPLE_WORLD_FAULT_AFTER_COUNT requires SAMPLE_WORLD_FAULT_AFTER_STAGE");
    return undefined;
  }
  if (environment.GOWM_ENV === "production") {
    throw new Error("Sample-world fault injection is never authorized in production");
  }
  if (!SAMPLE_FAULT_STAGES.includes(configuredStage as SampleFaultStage)) {
    throw new Error(`Unsupported SAMPLE_WORLD_FAULT_AFTER_STAGE; expected one of ${SAMPLE_FAULT_STAGES.join(",")}`);
  }
  const afterCount = configuredCount === undefined || configuredCount === "" ? 1 : Number(configuredCount);
  if (!Number.isSafeInteger(afterCount) || afterCount < 1) {
    throw new Error("SAMPLE_WORLD_FAULT_AFTER_COUNT must be a positive integer");
  }
  return {
    stage: configuredStage as SampleFaultStage,
    afterCount,
    observedCount: 0,
    triggered: false
  };
}

function sampleFaultInjectionFromEnvironment(): SampleFaultInjection | undefined {
  return parseSampleWorldFaultInjection(process.env);
}

function injectSampleFault(fault: SampleFaultInjection | undefined, stage: SampleFaultStage): void {
  if (!fault || fault.stage !== stage) return;
  fault.observedCount += 1;
  if (fault.observedCount !== fault.afterCount) return;
  fault.triggered = true;
  throw Object.assign(
    new Error(`Injected sample-world first-load failure after ${stage} count ${fault.afterCount}`),
    { code: "SAMPLE_WORLD_INJECTED_FAILURE", stage, afterCount: fault.afterCount }
  );
}

async function compensateFailedInitialLoad(
  pool: pg.Pool,
  loadError: unknown,
  beforeCounts: Record<string, number>,
  outputDirectory: string,
  epoch: string,
  fault: SampleFaultInjection | undefined
): Promise<Error> {
  try {
    const resetReport = await invokeProtectedReset(pool, false);
    const verificationReport = await invokeProtectedReset(pool, true);
    const afterCounts = await fixtureCounts(pool);
    const remainingAffectedRows = resetEvidenceCount(verificationReport, "affectedRowsBefore");
    if (!fixtureIsEmpty(afterCounts) || remainingAffectedRows !== 0) {
      throw new Error(
        `Protected compensation left fixture residue: counts=${canonicalJson(afterCounts)} affectedRows=${remainingAffectedRows}`
      );
    }
    const report = {
      schemaVersion: "1.0",
      fixtureId: FIXTURE_ID,
      fixtureVersion: FIXTURE_VERSION,
      status: "PASS",
      compensation: "PROTECTED_RESET_AND_VERIFIED_EMPTY",
      injectedFailure: Boolean(fault?.triggered),
      failureStage: fault?.triggered ? fault.stage : "load",
      failureCount: fault?.triggered ? fault.afterCount : null,
      failureCode: errorCode(loadError),
      failureMessage: errorMessage(loadError),
      fixtureCountsBefore: beforeCounts,
      fixtureCountsAfter: afterCounts,
      resetReport,
      verificationDryRunReport: verificationReport,
      generatedAt: epoch
    };
    await mkdir(outputDirectory, { recursive: true });
    await writeCanonical(resolve(outputDirectory, "LOAD_FAILURE_COMPENSATION_REPORT.json"), report);
    process.stdout.write(
      `SAMPLE_WORLD_LOAD_FAILURE_COMPENSATED stage=${String(report.failureStage)} remainingAffectedRows=${remainingAffectedRows}\n`
    );
    return Object.assign(
      new Error(`Sample-world first load failed and was compensated to an empty fixture: ${errorMessage(loadError)}`, {
        cause: loadError
      }),
      { code: "SAMPLE_WORLD_LOAD_FAILED_COMPENSATED", compensationReport: report }
    );
  } catch (resetError) {
    return Object.assign(
      new Error(
        `Sample-world first load failed and protected compensation could not prove an empty fixture: ${errorMessage(resetError)}`,
        { cause: loadError }
      ),
      { code: "SAMPLE_WORLD_LOAD_COMPENSATION_FAILED", resetError }
    );
  }
}

async function invokeProtectedReset(pool: pg.Pool, dryRun: boolean): Promise<Record<string, unknown>> {
  const result = await pool.query<{ report: Record<string, unknown> }>(
    "SELECT gowm_sample_fixture.reset_sample_world($1) AS report",
    [dryRun]
  );
  const report = result.rows[0]?.report;
  if (!report) throw new Error("Sample reset function returned no report");
  await validateSampleArtifact("sample-world-reset-report.schema.json", report);
  if (report.status !== "PASS" || report.nonFixtureRowsAffected !== 0) {
    throw new Error("Protected sample reset did not report a zero-impact PASS result");
  }
  const affectedRowsBefore = resetEvidenceCount(report, "affectedRowsBefore");
  const affectedRowsAfter = resetEvidenceCount(report, "affectedRowsAfter");
  if ((dryRun && affectedRowsAfter !== affectedRowsBefore) || (!dryRun && affectedRowsAfter !== 0)) {
    throw new Error(
      `Protected sample reset row evidence is inconsistent for dryRun=${dryRun}: before=${affectedRowsBefore} after=${affectedRowsAfter}`
    );
  }
  return report;
}

function resetEvidenceCount(report: Record<string, unknown>, key: string): number {
  const counts = report.deletedCounts;
  if (!counts || typeof counts !== "object") throw new Error("Sample reset report omitted deletedCounts evidence");
  const value = (counts as Record<string, unknown>)[key];
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`Sample reset report has invalid ${key} evidence`);
  }
  return numeric;
}

function fixtureIsEmpty(counts: Record<string, number>): boolean {
  return Object.values(counts).every((count) => count === 0);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as AnyRecord).code === "string") {
    return String((error as AnyRecord).code);
  }
  return "SAMPLE_WORLD_LOAD_FAILURE";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensureSampleScopes(pool: pg.Pool): Promise<void> {
  for (const scope of SCOPES) {
    await pool.query(
      `INSERT INTO data_scope(scope_key,operational_domain,description)
       VALUES ($1,'SIMULATION',$2) ON CONFLICT (scope_key) DO NOTHING`,
      [scope, `${FIXTURE_ID} isolated synthetic scope`]
    );
  }
}

async function loadReferenceIdentities(pool: pg.Pool, realization: SampleWorldRealization): Promise<void> {
  for (const entry of referenceEntries(realization)) {
    if (entry.targetKind !== "WORLD_OBJECT") continue;
    const identity = entry.identityReferenceKey ?? entry.referenceKey;
    if (typeof identity?.id !== "string" || typeof entry.entityId !== "string" ||
        typeof entry.scope !== "string" || typeof entry.targetKind !== "string") {
      throw new Error(`Incomplete generated reference-map entry: ${String(entry.fixtureKey)}`);
    }
    await pool.query(
      `INSERT INTO world_reference_identity(reference_key,entity_kind,internal_id,data_scope_key)
       SELECT $1,$2,$3,$4
       WHERE NOT EXISTS (
         SELECT 1 FROM world_reference_identity
         WHERE reference_key=$1 OR (entity_kind=$2 AND internal_id=$3)
       )
       ON CONFLICT DO NOTHING`,
      [identity.id, entry.targetKind, entry.entityId, entry.scope]
    );
    const stored = await pool.query<{
      reference_key: string;
      entity_kind: string;
      internal_id: string;
      data_scope_key: string;
    }>(
      `SELECT reference_key,entity_kind,internal_id,data_scope_key
       FROM world_reference_identity WHERE reference_key=$1 OR (entity_kind=$2 AND internal_id=$3)`,
      [identity.id, entry.targetKind, entry.entityId]
    );
    const row = stored.rows[0];
    if (!row || row.reference_key !== identity.id || row.entity_kind !== entry.targetKind ||
        row.internal_id !== entry.entityId || row.data_scope_key !== entry.scope) {
      throw new Error(`Immutable WORLD_OBJECT reference identity mismatch for ${String(entry.fixtureKey)}`);
    }
  }
}

export async function mutateSampleWorldDatabase(options: {
  connectionString?: string;
  epoch?: string;
  seed?: string;
  outputDirectory?: string;
} = {}): Promise<Record<string, unknown>> {
  const connectionString = options.connectionString ?? required("SAMPLE_LOADER_DATABASE_URL");
  const databaseName = assertSampleDatabaseConnection(connectionString, process.env.POSTGRES_DB);
  process.env.DATABASE_URL = connectionString;
  const epoch = normalizedEpoch(options.epoch ?? required("SAMPLE_WORLD_EPOCH"));
  const realization = await realizeSampleWorld({
    epoch,
    seed: options.seed ?? process.env.SAMPLE_WORLD_SEED ?? "gowm-wsgs-sample-world-v1",
    sourceRoot: process.env.SAMPLE_WORLD_SOURCE_ROOT ?? "test-data/wsgs-sample-world/v1"
  });
  const pool = new Pool({ connectionString, max: 4 });
  try {
    await assertMarker(pool, databaseName);
    const projectionWorldVersions = await loadObservations(pool, realization, "v2");
    await bindWorldObjectDescriptors(pool, realization);
    const state = await sampleState(pool);
    const ugv = await pool.query<{ geometry: unknown; state: unknown }>(
      `SELECT ST_AsGeoJSON(g.geometry)::jsonb AS geometry,s.state
       FROM world_object o JOIN world_object_state s ON s.object_id=o.id
       JOIN world_object_geometry g ON g.object_id=o.id
       WHERE o.properties->>'fixtureObjectKey'='ugv-002' AND o.data_scope_key='wsgs-demo'`
    );
    const report = {
      schemaVersion: "1.0",
      fixtureId: FIXTURE_ID,
      fixtureVersion: FIXTURE_VERSION,
      scenarioId: "move-ugv-002-to-zone-b",
      status: "PASS",
      loadedStateHash: sha256(canonicalJson(state)),
      projectionWorldVersions,
      ugv002: ugv.rows[0],
      generatedAt: epoch
    };
    const outputDirectory = resolve(options.outputDirectory ?? process.env.SAMPLE_WORLD_OUTPUT_DIRECTORY ?? ".runtime/wsgs-sample/output");
    await mkdir(outputDirectory, { recursive: true });
    await writeCanonical(resolve(outputDirectory, "MUTATION_REPORT.json"), report);
    await writeCanonical(resolve(outputDirectory, "SAMPLE_REFERENCE_MAP.json"), await realizedReferenceMap(pool, realization));
    process.stdout.write(`SAMPLE_WORLD_MUTATION_APPLIED stateHash=${report.loadedStateHash}\n`);
    return report;
  } finally {
    await pool.end();
  }
}

export async function resetSampleWorldDatabase(options: {
  connectionString?: string;
  dryRun?: boolean;
  outputDirectory?: string;
} = {}): Promise<Record<string, unknown>> {
  if (process.env.GOWM_ENV === "production") {
    throw new Error("Sample reset is never authorized for a production environment");
  }
  const connectionString = options.connectionString ?? required("SAMPLE_LOADER_DATABASE_URL");
  const databaseName = assertSampleDatabaseConnection(connectionString, process.env.POSTGRES_DB);
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await assertMarker(pool, databaseName);
    const report = await invokeProtectedReset(pool, options.dryRun ?? false);
    const outputDirectory = resolve(options.outputDirectory ?? process.env.SAMPLE_WORLD_OUTPUT_DIRECTORY ?? ".runtime/wsgs-sample/output");
    await mkdir(outputDirectory, { recursive: true });
    await writeCanonical(resolve(outputDirectory, "RESET_REPORT.json"), report);
    process.stdout.write(`${options.dryRun ? "SAMPLE_WORLD_RESET_DRY_RUN_PASS" : "SAMPLE_WORLD_RESET_DATA_PASS"}\n`);
    return report;
  } finally {
    await pool.end();
  }
}

async function loadCatalog(pool: pg.Pool, realization: SampleWorldRealization): Promise<void> {
  const value = realization as AnyRecord;
  const epoch = String(value.fixture.epoch);
  const datasets: AnyRecord[] = value.catalog.datasets;
  const layers: AnyRecord[] = value.catalog.layers;
  const references = referenceEntries(realization);
  await pool.query(
    `INSERT INTO analysis_space(analysis_space_key,canonical_srid,dimension_model,distance_model,transform_pipeline_version)
     VALUES ('wsgs-sample-utm50n',32650,'2D','PLANAR_METRE_V1','wsgs-sample-loader/1.0')
     ON CONFLICT (analysis_space_key) DO NOTHING`
  );

  for (const dataset of datasets) {
    const fixtureKey = String(dataset.fixtureDatasetKey);
    const scope = String(dataset.scope);
    const datasetScope = datasetScopeFor(value.spec, scope);
    const referenceId = identityId(references, fixtureKey, value.spec.namespace, scope, "DATASET");
    const datasetId = entityId(references, fixtureKey, `${value.spec.namespace}:dataset:${fixtureKey}`);
    await pool.query(
      `INSERT INTO spatial_dataset(dataset_id,reference_key,data_scope_key,dataset_scope_key,dataset_key,name)
       SELECT $1,$2,$3,$4,$5,$6
       WHERE NOT EXISTS (
         SELECT 1 FROM spatial_dataset
         WHERE dataset_id=$1 OR (data_scope_key=$3 AND dataset_scope_key=$4 AND dataset_key=$5)
       )
       ON CONFLICT (data_scope_key,dataset_scope_key,dataset_key) DO NOTHING`,
      [datasetId, referenceId, scope, datasetScope, fixtureKey, dataset.name]
    );
    await assertCatalogIdentity(pool, "DATASET", datasetId, referenceId, scope, datasetScope, fixtureKey);
    const version = dataset.version === "REALIZATION" ? String(value.fixture.realizationId) : String(dataset.version);
    const contentHash = prefixedHash({ dataset, fixtureId: FIXTURE_ID, fixtureVersion: FIXTURE_VERSION, realizationId: value.fixture.realizationId });
    await pool.query(
      `INSERT INTO spatial_dataset_version(
         dataset_version_id,dataset_id,version,dataset_kind,source_ref,source_version,schema_version,
         crs,valid_from,quality,lineage,content_hash,published_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'gowm-wsgs-sample-world/1.0',$7,$8,$9::jsonb,$10::jsonb,$11,$8)
       ON CONFLICT (dataset_id,version) DO NOTHING`,
      [stableUuid(`${value.spec.namespace}:dataset-version:${fixtureKey}:${version}`), datasetId, version,
       dataset.kind, `sample://${FIXTURE_ID}/dataset/${fixtureKey}`, FIXTURE_VERSION, dataset.crs ?? "EPSG:4326",
       epoch, JSON.stringify(dataset.quality ?? {}), JSON.stringify([dataset.provenance ?? {}]), contentHash]
    );
    await ensureDescriptor(pool, referenceId, scope, "DATASET", String(dataset.name), {
      fixtureId: FIXTURE_ID, fixtureVersion: FIXTURE_VERSION, fixtureKey, syntheticTestData: true
    }, version);
  }

  for (const layer of layers) {
    const fixtureKey = String(layer.fixtureLayerKey);
    const datasetKey = String(layer.dataset);
    const dataset = datasets.find((candidate) => candidate.fixtureDatasetKey === datasetKey);
    if (!dataset) throw new Error(`Unknown dataset for layer ${fixtureKey}`);
    const scope = String(dataset.scope);
    const datasetScope = datasetScopeFor(value.spec, scope);
    const datasetId = entityId(references, datasetKey, `${value.spec.namespace}:dataset:${datasetKey}`);
    const datasetVersion = dataset.version === "REALIZATION" ? String(value.fixture.realizationId) : String(dataset.version);
    const datasetVersionId = stableUuid(`${value.spec.namespace}:dataset-version:${datasetKey}:${datasetVersion}`);
    const layerId = entityId(references, fixtureKey, `${value.spec.namespace}:layer:${fixtureKey}`);
    const referenceId = identityId(references, fixtureKey, value.spec.namespace, scope, "LAYER");
    await pool.query(
      `INSERT INTO spatial_layer(layer_id,reference_key,dataset_id,data_scope_key,dataset_scope_key,layer_key,name)
       SELECT $1,$2,$3,$4,$5,$6,$7
       WHERE NOT EXISTS (
         SELECT 1 FROM spatial_layer WHERE layer_id=$1 OR (dataset_id=$3 AND layer_key=$6)
       )
       ON CONFLICT (dataset_id,layer_key) DO NOTHING`,
      [layerId, referenceId, datasetId, scope, datasetScope, fixtureKey, layer.name ?? fixtureKey]
    );
    await assertCatalogIdentity(pool, "LAYER", layerId, referenceId, scope, datasetScope, fixtureKey);
    await pool.query(
      `INSERT INTO spatial_layer_version(
         layer_version_id,layer_id,dataset_id,dataset_version_id,version,layer_type,geometry_type,
         schema_version,crs,source_ref,source_version,valid_from,quality,lineage,content_hash,published_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'gowm-wsgs-sample-world/1.0','EPSG:4326',$8,$9,$10,
                 $11::jsonb,$12::jsonb,$13,$10)
       ON CONFLICT (layer_id,version) DO NOTHING`,
      [stableUuid(`${value.spec.namespace}:layer-version:${fixtureKey}:${datasetVersion}`), layerId, datasetId,
       datasetVersionId, datasetVersion, "VECTOR", layer.geometryType,
       `sample://${FIXTURE_ID}/layer/${fixtureKey}`, FIXTURE_VERSION, epoch,
       JSON.stringify({ validationStatus: "VALIDATED", synthetic: true }), JSON.stringify([{ dataset: datasetKey }]),
       prefixedHash({ layer, datasetVersion, fixtureId: FIXTURE_ID })]
    );
    await ensureDescriptor(pool, referenceId, scope, "LAYER", String(layer.name ?? fixtureKey), {
      fixtureId: FIXTURE_ID, fixtureVersion: FIXTURE_VERSION, fixtureKey, syntheticTestData: true
    }, datasetVersion);
  }

  const features: AnyRecord[] = [...value.features.visible.features, ...value.features.hidden.features];
  for (const feature of features) {
    const fixtureKey = String(feature.properties.fixtureFeatureKey);
    const scope = String(feature.properties.scope);
    const layerKey = String(feature.properties.layer);
    const layer = layers.find((candidate) => candidate.fixtureLayerKey === layerKey);
    if (!layer) throw new Error(`Unknown layer for feature ${fixtureKey}`);
    const dataset = datasets.find((candidate) => candidate.fixtureDatasetKey === layer.dataset);
    if (!dataset) throw new Error(`Unknown dataset for feature ${fixtureKey}`);
    const version = dataset.version === "REALIZATION" ? `realization-${String(value.fixture.realizationId).slice(-32)}` : String(dataset.version);
    const featureId = entityId(references, fixtureKey, `${value.spec.namespace}:feature:${fixtureKey}`);
    const layerId = entityId(references, layerKey, `${value.spec.namespace}:layer:${layerKey}`);
    const referenceId = identityId(references, fixtureKey, value.spec.namespace, scope, "LAYER_FEATURE");
    await pool.query(
      `INSERT INTO spatial_feature_identity(
         feature_id,reference_key,layer_id,data_scope_key,dataset_scope_key,feature_key,feature_type,display_name
       ) SELECT $1,$2,$3,$4,$5,$6,$7,$8
       WHERE NOT EXISTS (
         SELECT 1 FROM spatial_feature_identity WHERE feature_id=$1 OR (layer_id=$3 AND feature_key=$6)
       )
       ON CONFLICT (layer_id,feature_key) DO NOTHING`,
      [featureId, referenceId, layerId, scope, datasetScopeFor(value.spec, scope), fixtureKey,
       String(feature.properties.objectType), feature.properties.displayName ?? feature.properties.name ?? fixtureKey]
    );
    await assertCatalogIdentity(pool, "LAYER_FEATURE", featureId, referenceId, scope,
      datasetScopeFor(value.spec, scope), fixtureKey);
    await pool.query(
      `INSERT INTO spatial_feature_version(
         feature_version_id,feature_id,layer_id,layer_version_id,version,geometry,properties,
         valid_from,source_feature_id,content_hash,published_at
       ) VALUES ($1,$2,$3,$4,$5,ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($6::jsonb)),4326),$7::jsonb,$8,$9,$10,$8)
       ON CONFLICT (feature_id,version) DO NOTHING`,
      [stableUuid(`${value.spec.namespace}:feature-version:${fixtureKey}:${version}`), featureId, layerId,
       stableUuid(`${value.spec.namespace}:layer-version:${layerKey}:${version}`), version,
       JSON.stringify(feature.geometry), JSON.stringify({ ...feature.properties, fixtureId: FIXTURE_ID, fixtureVersion: FIXTURE_VERSION }),
       epoch, String(feature.id), prefixedHash({ geometry: feature.geometry, properties: feature.properties, version })]
    );
    await ensureDescriptor(
      pool,
      referenceId,
      scope,
      "LAYER_FEATURE",
      String(feature.properties.displayName ?? feature.properties.name ?? fixtureKey),
      { fixtureId: FIXTURE_ID, fixtureVersion: FIXTURE_VERSION, fixtureKey, syntheticTestData: true },
      version
    );
  }
}

async function assertCatalogIdentity(
  pool: pg.Pool,
  kind: "DATASET" | "LAYER" | "LAYER_FEATURE",
  entityId: string,
  referenceId: string,
  scope: string,
  datasetScope: string,
  fixtureKey: string
): Promise<void> {
  const statement = kind === "DATASET"
    ? `SELECT dataset_id::text AS entity_id,reference_key,data_scope_key,dataset_scope_key,dataset_key AS fixture_key
       FROM spatial_dataset
       WHERE dataset_id=$1 OR reference_key=$2 OR (data_scope_key=$3 AND dataset_scope_key=$4 AND dataset_key=$5)`
    : kind === "LAYER"
      ? `SELECT layer_id::text AS entity_id,reference_key,data_scope_key,dataset_scope_key,layer_key AS fixture_key
         FROM spatial_layer
         WHERE layer_id=$1 OR reference_key=$2 OR
           (data_scope_key=$3 AND dataset_scope_key=$4 AND layer_key=$5)`
      : `SELECT feature_id::text AS entity_id,reference_key,data_scope_key,dataset_scope_key,feature_key AS fixture_key
         FROM spatial_feature_identity
         WHERE feature_id=$1 OR reference_key=$2 OR
           (data_scope_key=$3 AND dataset_scope_key=$4 AND feature_key=$5)`;
  const result = await pool.query<{
    entity_id: string;
    reference_key: string;
    data_scope_key: string;
    dataset_scope_key: string;
    fixture_key: string;
  }>(statement, [entityId, referenceId, scope, datasetScope, fixtureKey]);
  const row = result.rows[0];
  if (!row || row.entity_id !== entityId || row.reference_key !== referenceId ||
      row.data_scope_key !== scope || row.dataset_scope_key !== datasetScope || row.fixture_key !== fixtureKey) {
    throw new Error(`Immutable ${kind} catalog identity mismatch for ${fixtureKey}`);
  }
}

async function loadObjectsAndReferences(pool: pg.Pool, realization: SampleWorldRealization): Promise<void> {
  const value = realization as AnyRecord;
  const references = referenceEntries(realization);
  for (const object of value.objects as AnyRecord[]) {
    const fixtureKey = String(object.fixtureObjectKey);
    const scope = String(object.scope);
    const referenceId = identityId(references, fixtureKey, value.spec.namespace, scope, "WORLD_OBJECT");
    const objectId = entityId(references, fixtureKey, `${value.spec.namespace}:object:${fixtureKey}`);
    await pool.query(
      `INSERT INTO world_reference_identity(reference_key,entity_kind,internal_id,data_scope_key)
       VALUES ($1,'WORLD_OBJECT',$2,$3) ON CONFLICT (entity_kind,internal_id) DO NOTHING`,
      [referenceId, objectId, scope]
    );
    await pool.query(
      `INSERT INTO world_object(id,object_type,properties,data_scope_key)
       VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (id) DO NOTHING`,
      [objectId, object.objectType, JSON.stringify({ fixtureId: FIXTURE_ID, fixtureVersion: FIXTURE_VERSION,
        fixtureObjectKey: fixtureKey, name: object.canonicalName }), scope]
    );
    await ensureDescriptor(pool, referenceId, scope, "WORLD_OBJECT", String(object.canonicalName), {
      fixtureId: FIXTURE_ID, fixtureVersion: FIXTURE_VERSION, fixtureKey
    });
  }

  for (const reference of value.references as AnyRecord[]) {
    const fixtureKey = String(reference.targetFixtureKey);
    const scope = String(reference.scope);
    const targetKind = String(reference.targetKind);
    const referenceId = identityId(references, fixtureKey, value.spec.namespace, scope, targetKind);
    const objectVersion = await catalogObjectVersion(pool, referenceId, scope, targetKind);
    await ensureDescriptor(pool, referenceId, scope, String(reference.targetKind), String(reference.canonicalName), {
      fixtureId: FIXTURE_ID, fixtureVersion: FIXTURE_VERSION, fixtureKey, syntheticTestData: true
    }, objectVersion);
    await ensureName(pool, referenceId, scope, "CANONICAL_NAME", String(reference.canonicalName), `sample://${FIXTURE_ID}/reference/${fixtureKey}`);
    if (reference.displayName && reference.displayName !== reference.canonicalName) {
      await ensureName(pool, referenceId, scope, "DISPLAY_LABEL", String(reference.displayName), `sample://${FIXTURE_ID}/reference/${fixtureKey}`);
    }
    for (const alias of reference.aliases ?? []) {
      await ensureName(pool, referenceId, scope, "ALIAS", String(alias), `sample://${FIXTURE_ID}/reference/${fixtureKey}`);
    }
    for (const code of reference.codes ?? []) {
      await ensureName(pool, referenceId, scope, "CODE", String(code), `sample://${FIXTURE_ID}/reference/${fixtureKey}`);
      await ensureExternalIdentifier(pool, referenceId, scope, fixtureKey, String(code));
    }
  }
}

async function catalogObjectVersion(
  pool: pg.Pool,
  referenceId: string,
  scope: string,
  kind: string
): Promise<string | undefined> {
  const statement = kind === "DATASET"
    ? `SELECT version.version
       FROM spatial_dataset dataset
       JOIN spatial_dataset_version version ON version.dataset_id=dataset.dataset_id
       WHERE dataset.reference_key=$1 AND dataset.data_scope_key=$2
       ORDER BY version.published_at DESC,version.version DESC
       LIMIT 1`
    : kind === "LAYER"
      ? `SELECT version.version
         FROM spatial_layer layer_identity
         JOIN spatial_layer_version version ON version.layer_id=layer_identity.layer_id
         WHERE layer_identity.reference_key=$1 AND layer_identity.data_scope_key=$2
         ORDER BY version.published_at DESC,version.version DESC
         LIMIT 1`
      : kind === "LAYER_FEATURE"
        ? `SELECT version.version
           FROM spatial_feature_identity feature
           JOIN spatial_feature_version version ON version.feature_id=feature.feature_id
           WHERE feature.reference_key=$1 AND feature.data_scope_key=$2
           ORDER BY version.published_at DESC,version.version DESC
           LIMIT 1`
        : undefined;
  if (!statement) return undefined;
  const result = await pool.query<{ version: string }>(statement, [referenceId, scope]);
  const version = result.rows[0]?.version;
  if (!version) throw new Error(`Catalog descriptor target is missing an immutable version: ${kind} ${referenceId}`);
  return version;
}

async function bindWorldObjectDescriptors(
  pool: pg.Pool,
  realization: SampleWorldRealization
): Promise<void> {
  const value = realization as AnyRecord;
  const references = referenceEntries(realization);
  const referenceFixtures = new Map<string, AnyRecord>(
    (value.references as AnyRecord[])
      .filter((reference) => reference.targetKind === "WORLD_OBJECT")
      .map((reference) => [String(reference.targetFixtureKey), reference])
  );
  for (const object of value.objects as AnyRecord[]) {
    const fixtureKey = String(object.fixtureObjectKey);
    const scope = String(object.scope);
    const reference = referenceFixtures.get(fixtureKey);
    if (!reference) throw new Error(`WORLD_OBJECT descriptor fixture is missing: ${fixtureKey}`);
    const referenceId = identityId(references, fixtureKey, value.spec.namespace, scope, "WORLD_OBJECT");
    const objectId = entityId(references, fixtureKey, `${value.spec.namespace}:object:${fixtureKey}`);
    const current = await pool.query<{ version: string }>(
      `SELECT version::text AS version
       FROM world_object_state
       WHERE object_id=$1`,
      [objectId]
    );
    const objectVersion = current.rows[0]?.version;
    if (!objectVersion) {
      throw new Error(`WORLD_OBJECT descriptor target is missing a current projection version: ${fixtureKey}`);
    }
    await ensureDescriptor(
      pool,
      referenceId,
      scope,
      "WORLD_OBJECT",
      String(reference.canonicalName),
      {
        fixtureId: FIXTURE_ID,
        fixtureVersion: FIXTURE_VERSION,
        fixtureKey,
        syntheticTestData: true
      },
      objectVersion
    );
  }
}

async function loadObservations(
  pool: pg.Pool,
  realization: SampleWorldRealization,
  revision: "v1" | "v2",
  fault?: SampleFaultInjection
): Promise<Record<string, number>> {
  const value = realization as AnyRecord;
  const objects = new Map<string, AnyRecord>((value.objects as AnyRecord[]).map((item: AnyRecord) => [String(item.fixtureObjectKey), item]));
  const inputs: AnyRecord[] = revision === "v1"
    ? value.observations
    : (value.mutations as AnyRecord[]).map((mutation: AnyRecord) => {
        const baseline = (value.observations as AnyRecord[]).find((item: AnyRecord) => item.subjectFixtureKey === mutation.subjectFixtureKey);
        if (!baseline) throw new Error(`Mutation subject is missing a v1 observation: ${mutation.subjectFixtureKey}`);
        return {
          ...baseline,
          ...mutation,
          observationKey: `obs:${mutation.subjectFixtureKey}:v2`,
          sourceRevisionNo: 2,
          supersedesObservationKey: baseline.observationKey,
          scope: baseline.scope,
          observer: baseline.observer,
          observationType: baseline.observationType,
          source: baseline.source,
          correlationId: "gowm-wsgs-sample-v2",
          metadata: { ...baseline.metadata, scenarioId: mutation.scenarioId }
        };
      });
  const repository = new ObservationRepository(pool);
  const projector = new ProjectionProcessor(pool);
  const versions: Record<string, number> = {};
  const observationIds = new Map<string, string>([
    ...(value.observations as AnyRecord[]),
    ...(value.mutations as AnyRecord[])
  ].map((candidate: AnyRecord) => [String(candidate.observationKey ?? candidate.idempotencyKey), String(candidate.observationId)]));
  for (const item of inputs) {
    const recordIdentity = sampleObservationRecordIdentity(item);
    const fixtureKey = String(item.subjectFixtureKey);
    const object = objects.get(fixtureKey);
    if (!object) throw new Error(`Unknown observation subject ${fixtureKey}`);
    const scope = String(item.scope);
    const objectId = entityId(referenceEntries(realization), fixtureKey, `${value.spec.namespace}:object:${fixtureKey}`);
    const source = `${String(item.source)}:${scope}`;
    const geometry = item.geometry as { type: "Point"; coordinates: [number, number] };
    const position = await normalizedPosition(pool, geometry.coordinates);
    const observationId = typeof item.observationId === "string"
      ? item.observationId
      : observationIdFor(value.spec.namespace, recordIdentity.observationKey);
    const observedAt = realizedTimestamp(item, "observedAt", "observedOffsetMs", value.fixture.epoch);
    const receivedAt = realizedTimestamp(item, "receivedAt", "receivedOffsetMs", value.fixture.epoch);
    const windowEnd = new Date(Date.parse(observedAt) + 1).toISOString();
    const input: JsonObject = {
      schemaVersion: "1.2",
      observationId,
      dataScopeKey: scope,
      sourceRecordKey: recordIdentity.sourceRecordKey,
      sourceRevisionNo: Number(item.sourceRevisionNo ?? (revision === "v2" ? 2 : 1)),
      ...(item.supersedesObservationKey ? {
        supersedesObservationId: observationIds.get(String(item.supersedesObservationKey)) ??
          observationIdFor(value.spec.namespace, String(item.supersedesObservationKey))
      } : {}),
      originKind: "SIMULATION",
      observer: item.observer,
      subject: { type: object.objectType, id: objectId },
      sourceLocalTargetId: objectId,
      observationType: String(item.observationType),
      source,
      datastreamKey: `wsgs-sample:${scope}:positions`,
      producerPipelineKey: `wsgs-sample:${scope}:loader-v1`,
      rawReference: recordIdentity.rawReference,
      correlationId: String(item.correlationId),
      qualityFlags: ["SYNTHETIC_TEST_DATA", "DETERMINISTIC_FIXTURE"],
      metadata: { ...item.metadata, originalSource: item.source, realizationId: value.fixture.realizationId },
      timeSolution: {
        phenomenonTimeEstimate: observedAt,
        phenomenonTimeWindow: { start: observedAt, end: windowEnd },
        uncertaintySeconds: 0.01,
        correctionMethod: "SAMPLE_WORLD_FIXED_EPOCH",
        clockModelVersion: `sample-clock-${scope}-v1`,
        clockDomain: "SYNTHETIC_EPOCH",
        clockOffsetSeconds: 0,
        clockResidualSigmaMs: 0,
        clockEstimationMethod: "FIXED_OFFSET",
        sourceTime: observedAt,
        upstreamReceivedTime: receivedAt
      },
      measurements: [{
        measurementId: stableUuid(`${value.spec.namespace}:measurement:${recordIdentity.observationKey}`),
        measurementKey: "position",
        measurementStage: "NORMALIZED",
        observedProperty: "position",
        resultKind: "POSITION",
        analysisSpaceKey: "wsgs-sample-utm50n",
        position: { ...position, srid: 32650 },
        sourceGeometry: geometry,
        uncertainty: { model: "HARD_RADIUS", unit: "m", horizontalValue: 0.1, confidenceLevel: Number(item.confidence ?? 0.99) },
        measurementModel: "GOWM_WSGS_SAMPLE_SYNTHETIC_POSITION",
        measurementModelVersion: "1.0.0",
        algorithmConfidence: Number(item.confidence ?? 0.99),
        qualityScore: 1,
        qualityFlags: ["SYNTHETIC_TEST_DATA"],
        manualCutBefore: revision === "v2",
        attributes: item.value
      }],
      assertions: [],
      entityBindingStatus: "DECLARED"
    };
    const bundle = normalizeObservationInput(input, receivedAt);
    const existing = await pool.query<{ payload_hash: string; projected_at: Date | null }>(
      "SELECT payload_hash,projected_at FROM world_observation WHERE observation_id=$1",
      [observationId]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].payload_hash !== bundle.payloadHash) throw new Error(`Immutable observation conflict: ${observationId}`);
      const current = await pool.query<{ version: string }>("SELECT version::text FROM world_object_state WHERE object_id=$1", [objectId]);
      versions[fixtureKey] = Number(current.rows[0]?.version ?? 0);
      continue;
    }
    await repository.insert(bundle);
    injectSampleFault(fault, "observation-insert");
    const projection = await projector.process(observationId);
    if (!projection.decision.apply) throw new Error(`Projection did not apply for ${recordIdentity.observationKey}: ${projection.decision.reason}`);
    versions[fixtureKey] = projection.worldVersion;
    injectSampleFault(fault, "projection");
  }
  return Object.fromEntries(Object.entries(versions).sort(([left], [right]) => compareUnicodeCodePoints(left, right)));
}

async function ensureDescriptor(
  pool: pg.Pool,
  referenceId: string,
  scope: string,
  kind: string,
  displayName: string,
  provenance: JsonObject,
  objectVersion?: string
): Promise<void> {
  const evidenceReference = sampleFixtureEvidenceReference(provenance, referenceId);
  const contentHash = prefixedHash({
    referenceId,
    scope,
    kind,
    displayName,
    objectVersion: objectVersion ?? null,
    provenance: evidenceReference
  });
  await pool.query(
    `INSERT INTO world_reference_descriptor_version(
       reference_key,data_scope_key,reference_type,display_name,object_version,provenance,content_hash
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (reference_key,content_hash) DO NOTHING`,
    [referenceId, scope, kind, displayName, objectVersion ?? null, JSON.stringify([evidenceReference]), contentHash]
  );
}

export function sampleFixtureEvidenceReference(provenance: JsonObject, referenceId: string): JsonObject {
  const fixtureId = typeof provenance.fixtureId === "string" ? provenance.fixtureId : FIXTURE_ID;
  const fixtureVersion = typeof provenance.fixtureVersion === "string" ? provenance.fixtureVersion : FIXTURE_VERSION;
  const fixtureKey = typeof provenance.fixtureKey === "string" ? provenance.fixtureKey : referenceId;
  const evidenceId = `sample://${encodeURIComponent(fixtureId)}/${encodeURIComponent(fixtureVersion)}/${encodeURIComponent(fixtureKey)}`;
  if (evidenceId.length > 256) throw new Error(`Sample fixture evidence identity is too long for ${referenceId}`);
  return {
    evidenceId,
    authority: "GOWM Synthetic Test Fixture",
    evidenceType: "SYNTHETIC_FIXTURE"
  };
}

async function ensureName(
  pool: pg.Pool,
  referenceId: string,
  scope: string,
  kind: string,
  text: string,
  source: string
): Promise<void> {
  await pool.query(
    `INSERT INTO world_reference_name(
       name_id,reference_key,data_scope_key,name_kind,language_tag,name_text,normalized_text,source_ref,evidence,confidence
     ) SELECT $1,$2,$3,$4,'zh-CN',$5,normalize_reference_text($5),$6,$7::jsonb,1
       WHERE NOT EXISTS (
         SELECT 1 FROM world_reference_name
         WHERE reference_key=$2 AND data_scope_key=$3 AND name_kind=$4
           AND normalized_text=normalize_reference_text($5) AND source_ref=$6
       )`,
    [stableUuid(`${referenceId}:name:${kind}:${text}:${source}`), referenceId, scope, kind, text, source,
     JSON.stringify([{ fixtureId: FIXTURE_ID, fixtureVersion: FIXTURE_VERSION }])]
  );
}

async function ensureExternalIdentifier(
  pool: pg.Pool,
  referenceId: string,
  scope: string,
  fixtureKey: string,
  code: string
): Promise<void> {
  await pool.query(
    `INSERT INTO world_reference_external_identifier(
       external_identifier_id,reference_key,data_scope_key,authority,identifier_kind,identifier_value,
       normalized_value,confidence,evidence
     ) VALUES ($1,$2,$3,'GOWM_WSGS_SAMPLE','CODE',$4,normalize_reference_text($4),1,$5::jsonb)
       ON CONFLICT (data_scope_key,authority,identifier_kind,normalized_value,reference_key) DO NOTHING`,
    [stableUuid(`${referenceId}:external:CODE:${code}`), referenceId, scope, code,
     JSON.stringify([{ fixtureId: FIXTURE_ID, fixtureKey }])]
  );
}

async function normalizedPosition(pool: pg.Pool, coordinates: [number, number]): Promise<{ x: number; y: number }> {
  const result = await pool.query<{ x: number; y: number }>(
    `SELECT ST_X(projected)::double precision AS x,ST_Y(projected)::double precision AS y
     FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint($1,$2),4326),32650) AS projected) value`,
    coordinates
  );
  const row = result.rows[0];
  if (!row) throw new Error("PostGIS coordinate normalization returned no row");
  return { x: Number(row.x), y: Number(row.y) };
}

async function sampleState(pool: pg.Pool): Promise<JsonObject> {
  const [objects, features, datasets, references] = await Promise.all([
    pool.query(`SELECT o.id,o.object_type,o.data_scope_key,s.state,ST_AsGeoJSON(g.geometry)::jsonb AS geometry,
                       s.confidence,s.observed_at,s.source
                FROM world_object o JOIN world_object_state s ON s.object_id=o.id
                JOIN world_object_geometry g ON g.object_id=o.id
                WHERE o.properties->>'fixtureId'=$1 ORDER BY o.data_scope_key,o.id`, [FIXTURE_ID]),
    pool.query(`SELECT i.feature_key,i.feature_type,i.data_scope_key,v.version,
                       ST_AsGeoJSON(v.geometry)::jsonb AS geometry,v.properties
                FROM spatial_feature_identity i JOIN LATERAL (
                  SELECT candidate.* FROM spatial_feature_version candidate
                  WHERE candidate.feature_id=i.feature_id ORDER BY candidate.published_at DESC,candidate.version DESC LIMIT 1
                ) v ON true WHERE v.properties->>'fixtureId'=$1 ORDER BY i.data_scope_key,i.feature_key`, [FIXTURE_ID]),
    pool.query(`SELECT d.dataset_key,d.data_scope_key,d.dataset_scope_key,v.version,v.dataset_kind,v.content_hash
                FROM spatial_dataset d JOIN LATERAL (
                  SELECT candidate.* FROM spatial_dataset_version candidate
                  WHERE candidate.dataset_id=d.dataset_id ORDER BY candidate.published_at DESC,candidate.version DESC LIMIT 1
                ) v ON true WHERE d.dataset_key LIKE 'sample-%' OR d.dataset_key='hidden-base-vector'
                ORDER BY d.data_scope_key,d.dataset_key`),
    pool.query(`SELECT entity_kind,internal_id,data_scope_key,reference_key FROM world_reference_identity
                WHERE data_scope_key=ANY($1::text[]) AND entity_kind IN ('WORLD_OBJECT','DATASET','LAYER','LAYER_FEATURE')
                ORDER BY data_scope_key,entity_kind,internal_id`, [SCOPES])
  ]);
  return { objects: objects.rows, features: features.rows, datasets: datasets.rows, references: references.rows };
}

async function fixtureCounts(pool: pg.Pool): Promise<Record<string, number>> {
  const result = await pool.query<{ objects: string; observations: string; features: string; datasets: string; references: string }>(`
    SELECT
      (SELECT count(*) FROM world_object WHERE properties->>'fixtureId'=$1)::text AS objects,
      (SELECT count(*) FROM world_observation WHERE metadata->>'fixtureId'=$1)::text AS observations,
      (SELECT count(*) FROM spatial_feature_version WHERE properties->>'fixtureId'=$1)::text AS features,
      (SELECT count(*) FROM spatial_dataset WHERE dataset_key LIKE 'sample-%' OR dataset_key='hidden-base-vector')::text AS datasets,
      (SELECT count(*) FROM world_reference_identity
       WHERE data_scope_key=ANY($2::text[]) AND entity_kind IN ('WORLD_OBJECT','DATASET','LAYER','LAYER_FEATURE'))::text AS references
  `, [FIXTURE_ID, SCOPES]);
  const row = result.rows[0];
  if (!row) throw new Error("Fixture count query returned no row");
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

function assertExpectedCounts(counts: Record<string, number>): void {
  const expected: Record<string, number> = { objects: 7, observations: 7, features: 9, datasets: 4, references: 26 };
  for (const [key, count] of Object.entries(expected)) {
    if (counts[key] !== count) throw new Error(`Fixture count mismatch for ${key}: expected ${count}, got ${counts[key]}`);
  }
}

async function realizedReferenceMap(pool: pg.Pool, realization: SampleWorldRealization): Promise<JsonObject> {
  const entries = referenceEntries(realization);
  const output: AnyRecord[] = [];
  for (const entry of entries) {
    const identity = entry.identityReferenceKey ?? entry.referenceKey;
    const current = await pool.query<{ identity_version: string; catalog_version: string | null; world_version: string | null }>(
      `SELECT descriptor.descriptor_version::text AS identity_version,
              CASE identity.entity_kind
                WHEN 'DATASET' THEN (SELECT version FROM spatial_dataset_version WHERE dataset_id=identity.internal_id::uuid ORDER BY published_at DESC,version DESC LIMIT 1)
                WHEN 'LAYER' THEN (SELECT version FROM spatial_layer_version WHERE layer_id=identity.internal_id::uuid ORDER BY published_at DESC,version DESC LIMIT 1)
                WHEN 'LAYER_FEATURE' THEN (SELECT version FROM spatial_feature_version WHERE feature_id=identity.internal_id::uuid ORDER BY published_at DESC,version DESC LIMIT 1)
                ELSE NULL
              END AS catalog_version,
              CASE identity.entity_kind
                WHEN 'WORLD_OBJECT' THEN (SELECT version::text FROM world_object_state WHERE object_id=identity.internal_id)
                ELSE NULL
              END AS world_version
       FROM world_reference_identity identity
       LEFT JOIN LATERAL (
         SELECT descriptor_version FROM world_reference_descriptor_version candidate
         WHERE candidate.reference_key=identity.reference_key ORDER BY descriptor_version DESC LIMIT 1
       ) descriptor ON true WHERE identity.reference_key=$1`,
      [identity.id]
    );
    const versions = current.rows[0];
    output.push({
      ...entry,
      identityReferenceKey: { ...identity, version: versions?.identity_version ?? identity.version },
      ...(versions?.catalog_version ? { currentCatalogReferenceKey: { ...identity, version: versions.catalog_version } } : {}),
      ...(versions?.world_version ? { currentWorldReferenceKey: { ...identity, version: versions.world_version } } : {})
    });
  }
  return {
    schemaVersion: "1.0",
    fixtureId: FIXTURE_ID,
    fixtureVersion: FIXTURE_VERSION,
    realizationId: (realization as AnyRecord).fixture.realizationId,
    entries: output.sort((left, right) => compareUnicodeCodePoints(
      String(left.fixtureKey ?? left.targetFixtureKey),
      String(right.fixtureKey ?? right.targetFixtureKey)
    ))
  };
}

function referenceEntries(realization: SampleWorldRealization): AnyRecord[] {
  const map = (realization as AnyRecord).referenceMap;
  if (Array.isArray(map)) return map;
  if (Array.isArray(map?.entries)) return map.entries;
  if (map && typeof map === "object") return Object.values(map);
  return [];
}

function identityId(entries: AnyRecord[], fixtureKey: string, namespace: string, scope: string, kind: string): string {
  const found = entries.find((entry) =>
    entry.fixtureKey === fixtureKey || entry.targetFixtureKey === fixtureKey || entry.fixtureReferenceKey === fixtureKey
  );
  const id = found?.identityReferenceKey?.id ?? found?.referenceKey?.id;
  if (typeof id === "string") return id;
  return `wrf_${createHash("sha256").update(`${namespace}\0${scope}\0${kind}\0${fixtureKey}`).digest("hex").slice(0, 32)}`;
}

function entityId(entries: AnyRecord[], fixtureKey: string, fallbackSeed: string): string {
  const found = entries.find((entry) =>
    entry.fixtureKey === fixtureKey || entry.targetFixtureKey === fixtureKey || entry.fixtureReferenceKey === fixtureKey
  );
  return typeof found?.entityId === "string" ? found.entityId : stableUuid(fallbackSeed);
}

function datasetScopeFor(spec: AnyRecord, scope: string): string {
  const found = (spec.scopes as AnyRecord[]).find((candidate) => candidate.dataScope === scope);
  if (!found) throw new Error(`No dataset scope declared for ${scope}`);
  return String(found.datasetScope);
}

function realizedTimestamp(item: AnyRecord, field: string, offsetField: string, epoch: string): string {
  if (typeof item[field] === "string") return normalizedEpoch(item[field]);
  return new Date(Date.parse(epoch) + Number(item[offsetField] ?? 0)).toISOString();
}

function observationIdFor(namespace: string, key: string): string {
  return `obs_${createHash("sha256").update(`${namespace}:observation:${key}`).digest("hex").slice(0, 32)}`;
}

function stableUuid(value: string): string {
  const bytes = Buffer.from(createHash("sha256").update(value).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function prefixedHash(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedEpoch(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`Invalid sample epoch: ${value}`);
  return timestamp.toISOString();
}

export function validatedSampleDatabaseName(
  value: string | undefined,
  name = "POSTGRES_DB"
): string {
  if (!value) throw new Error(`${name} is required`);
  if (value !== value.trim() || !SAMPLE_DATABASE_NAME.test(value)) {
    throw new Error(`${name} must identify the shared sample database or a bounded q-* qualification database`);
  }
  return value;
}

export function assertSampleDatabaseConnection(
  connectionString: string,
  expectedDatabaseName: string | undefined
): string {
  const expected = validatedSampleDatabaseName(expectedDatabaseName);
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Sample database connection must use PostgreSQL");
  }
  let actual: string;
  try {
    actual = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("Sample database connection contains an invalid database name");
  }
  if (actual !== expected) {
    throw new Error("Refusing sample writes because the database URL differs from validated POSTGRES_DB");
  }
  return expected;
}

export function sampleDatabaseMarker(databaseName: string): string {
  return `${validatedSampleDatabaseName(databaseName, "database name")}/${FIXTURE_SCHEMA_VERSION}`;
}

export function sampleRuntimeInstanceIdForDatabaseName(databaseName: string): string {
  const validated = validatedSampleDatabaseName(databaseName, "database name");
  if (validated === "gowm_wsgs_sample") return "shared";
  const instanceId = validated.slice("gowm_wsgs_sample_".length).replaceAll("_", "-");
  if (!SAMPLE_RUNTIME_INSTANCE_ID.test(instanceId)) {
    throw new Error("Qualification database does not map to a bounded runtime instance identity");
  }
  return instanceId;
}

async function assertMarker(pool: pg.Pool, expectedDatabaseName: string): Promise<void> {
  const database = await pool.query<{ database_name: string }>("SELECT current_database() AS database_name");
  if (database.rows.length !== 1 || database.rows[0]?.database_name !== expectedDatabaseName) {
    throw new Error("Sample database marker name differs from validated POSTGRES_DB");
  }
  const marker = await pool.query<{
    fixture_id: string;
    schema_version: string;
    allowed_data_scopes: string[];
    runtime_instance_id: string;
    database_name: string;
  }>(
    "SELECT fixture_id,schema_version,allowed_data_scopes,runtime_instance_id,database_name FROM gowm_sample_fixture.instance_marker"
  );
  const row = marker.rows[0];
  if (row?.fixture_id !== FIXTURE_ID || row.schema_version !== FIXTURE_SCHEMA_VERSION ||
      row.runtime_instance_id !== sampleRuntimeInstanceIdForDatabaseName(expectedDatabaseName) ||
      row.database_name !== expectedDatabaseName ||
      canonicalJson(row.allowed_data_scopes) !== canonicalJson([...SCOPES])) {
    throw new Error("Sample instance marker mismatch");
  }
  if (process.env.GOWM_ENV === "production") {
    throw new Error("Sample loader is never authorized for a production environment");
  }
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(sortValue(value), null, 2)}\n`, "utf8");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
      .map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
