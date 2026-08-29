import { createHash, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { canonicalJson } from "../../packages/observation-model/src/canonical.js";
import {
  canonicalSha256,
  validateAgainstSchema,
  type DelegationTokenClaims
} from "../../packages/platform/contract-runtime/src/index.js";
import { semanticSourceFingerprint } from "../../packages/platform/semantic-conformance/src/index.js";
import {
  loadControlledProviderDeployments,
  type ControlledProviderDeployment
} from "../../services/gateway/world-capability-gateway/src/config.js";
import { realizeSampleWorld, type SampleWorldRealization } from "./model.js";
import {
  sampleGatewayBaseUrl,
  samplePostgresEndpoint,
  type SampleRuntimeEnvironment
} from "./runtime.js";

type AnyRecord = Record<string, any>;

const { Pool } = pg;
const FIXTURE_ID = "gowm-wsgs-sample-world";
const FIXTURE_SCHEMA_VERSION = "gowm-wsgs-sample-world/1.0";
const EXPECTED_SCOPES = ["wsgs-demo", "wsgs-hidden"] as const;

export const REQUIRED_SAMPLE_OPERATIONS = [
  "reference.get",
  "reference.resolve",
  "world.get-current-state",
  "world.get-geometry",
  "world.get-provenance",
  "catalog.get",
  "catalog.search",
  "spatial.find-nearby",
  "spatial.find-in-area",
  "spatial.find-intersections",
  "reference.validate",
  "result.validate"
] as const;

export const SAMPLE_RUNTIME_PROVIDER_IDS = [
  "gowm.reference-catalog",
  "gowm.dataset-catalog",
  "gowm.world-evidence",
  "gowm.spatial-analysis.bridge",
  "gowm.platform-validation"
] as const;

export interface SampleAvailabilityProbePlan {
  requiredOperations: readonly string[];
  absentProviderProbes: readonly {
    providerId: string;
    operationId: string;
    operationVersion: string;
  }[];
}

export interface LiveSampleInstanceStatus {
  fixtureId: string;
  databaseMarker: string;
  realizationId: string;
  revision: "v1" | "v2";
  loadedStateHash: string;
  requiredAvailable: number;
}

export async function probeLiveSampleInstance(
  runtime: SampleRuntimeEnvironment,
  options: { expectedRevision?: "v1" | "v2" } = {}
): Promise<LiveSampleInstanceStatus> {
  const source = await realizeSampleWorld({
    epoch: runtime.values.SAMPLE_WORLD_EPOCH!,
    seed: runtime.values.SAMPLE_WORLD_SEED!
  });
  await assertGatewayReady(runtime);
  await assertSignedRequiredAvailability(runtime);
  const database = await inspectLiveDatabase(runtime, source);
  if (options.expectedRevision !== undefined && database.revision !== options.expectedRevision) {
    throw new Error(`Sample instance revision is ${database.revision}; expected ${options.expectedRevision}`);
  }
  return { ...database, requiredAvailable: REQUIRED_SAMPLE_OPERATIONS.length };
}

export async function assertCurrentV1Artifacts(
  runtime: SampleRuntimeEnvironment,
  realization: SampleWorldRealization,
  live: LiveSampleInstanceStatus
): Promise<void> {
  const baseUrl = sampleGatewayBaseUrl(runtime);
  if (live.revision !== "v1" || live.realizationId !== realization.fixture.realizationId) {
    throw new Error("Handoff requires the live v1 state from the current realization");
  }

  const generatedManifest = await readJson(resolve(
    runtime.paths.generatedDirectory,
    "sample-world-realization-manifest.json"
  ));
  if (canonicalJson(generatedManifest) !== canonicalJson(realization.manifest)) {
    throw new Error("Generated realization manifest is stale");
  }

  for (const artifact of realization.artifacts) {
    const bytes = await readFile(resolve(runtime.paths.generatedDirectory, artifact.path));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== artifact.sha256 || bytes.byteLength !== artifact.bytes) {
      throw new Error(`Generated sample artifact is stale: ${artifact.path}`);
    }
  }

  const [
    loadReport,
    loadEvidence,
    canaryReport,
    canaryEvidence,
    canaryEvidenceSchema,
    currentSourceDigest,
    catalogResponse,
    semanticResponse
  ] = await Promise.all([
    readJson(resolve(runtime.paths.outputDirectory, "LOAD_REPORT.json")),
    readJson(resolve(runtime.paths.outputDirectory, "LOAD_EVIDENCE.json")),
    readJson(resolve(runtime.paths.outputDirectory, "CANARY_REPORT.json")),
    readJson(resolve(runtime.paths.outputDirectory, "CANARY_EVIDENCE_REPORT.json")),
    readJson(resolve(
      runtime.paths.root,
      "contracts/wsgs-sample-world/v1/sample-world-canary-evidence-report.schema.json"
    )),
    semanticSourceFingerprint(runtime.paths.root),
    fetch(`${baseUrl}/v1/capabilities`, { signal: AbortSignal.timeout(30_000) }),
    fetch(`${baseUrl}/v1/capability-semantics`, { signal: AbortSignal.timeout(30_000) })
  ]);
  const evidenceValidation = validateAgainstSchema(canaryEvidenceSchema, canaryEvidence, {
    schemaName: "sample-world-canary-evidence-report.schema.json"
  });
  if (!evidenceValidation.valid) {
    throw new Error(`Current v1.1 canary evidence contract mismatch: ${JSON.stringify(evidenceValidation.issues)}`);
  }
  if (!catalogResponse.ok || !semanticResponse.ok) {
    throw new Error("Current canary evidence cannot be bound to live capability/semantic catalogs");
  }
  const [catalog, semantics] = await Promise.all([
    catalogResponse.json() as Promise<AnyRecord>,
    semanticResponse.json() as Promise<AnyRecord>
  ]);
  if (loadReport.status !== "PASS" ||
      loadReport.sourceFixtureHash !== realization.fixture.sourceFixtureHash ||
      loadReport.realizationHash !== realization.fixture.realizationHash) {
    throw new Error("Load report does not match the current realization hashes");
  }
  if (loadEvidence.realizationId !== realization.fixture.realizationId ||
      loadEvidence.loadedStateHash !== live.loadedStateHash) {
    throw new Error("Live database state hash does not match the v1 load evidence");
  }
  if (canaryReport.status !== "PASS" || canaryReport.fixtureHash !== realization.fixture.sourceFixtureHash) {
    throw new Error("Fresh v1 canary report does not match the current source fixture hash");
  }
  if (canaryEvidence.status !== "PASS" ||
      canaryEvidence.gatewayBaseUrlHash !== canonicalSha256(baseUrl) ||
      canaryEvidence.fixtureHash !== realization.fixture.sourceFixtureHash ||
      canaryEvidence.fixtureHash !== canaryReport.fixtureHash ||
      canaryEvidence.realizationId !== realization.fixture.realizationId ||
      canaryEvidence.realizationId !== live.realizationId ||
      canaryEvidence.loadedStateHash !== live.loadedStateHash ||
      canaryEvidence.sourceDigest !== currentSourceDigest ||
      canaryEvidence.contractCatalogRevision !== catalog.contractCatalogRevision ||
      canaryEvidence.contractCatalogRevision !== semantics.contractCatalogRevision ||
      canaryEvidence.semanticCatalogHash !== semantics.catalogHash ||
      canonicalJson(canaryEvidence.cases) !== canonicalJson(canaryReport.cases)) {
    throw new Error("Current v1.1 canary evidence is stale or differs from the live instance and legacy report");
  }
}

async function assertGatewayReady(runtime: SampleRuntimeEnvironment): Promise<void> {
  const response = await fetch(`${sampleGatewayBaseUrl(runtime)}/health/ready`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Sample Gateway is not ready: HTTP ${response.status}`);
}

async function assertSignedRequiredAvailability(runtime: SampleRuntimeEnvironment): Promise<void> {
  const baseUrl = sampleGatewayBaseUrl(runtime);
  const deployments = await loadControlledProviderDeployments(resolve(
    runtime.paths.root,
    "config/world-platform-gateway-registry.json"
  ));
  const probePlan = buildSampleAvailabilityProbePlan(deployments);
  const catalogResponse = await fetch(`${baseUrl}/v1/capabilities`, { signal: AbortSignal.timeout(30_000) });
  if (!catalogResponse.ok) throw new Error(`Sample capability catalog is unavailable: HTTP ${catalogResponse.status}`);
  const catalog = await catalogResponse.json() as AnyRecord;
  for (const operationId of REQUIRED_SAMPLE_OPERATIONS) {
    const descriptor = (catalog.capabilities as AnyRecord[] | undefined)?.find((candidate) =>
      candidate.operationId === operationId && candidate.operationVersion === "1.0"
    );
    if (!descriptor || descriptor.maturity !== "STABLE") {
      throw new Error(`Required live operation is not Stable: ${operationId}@1.0`);
    }
  }

  // Keep live-provider readiness probes separate from intentionally absent
  // Provider probes. A batch containing both can exhaust the shared five-second
  // control-plane budget on negative DNS lookups and incorrectly starve a live
  // Provider check.
  const requiredBody = await signedAvailability(
    runtime,
    `sample-status-required-${randomUUID()}`,
    [...REQUIRED_SAMPLE_OPERATIONS]
  );
  const absentBody = await signedAvailability(
    runtime,
    `sample-status-absent-${randomUUID()}`,
    probePlan.absentProviderProbes.map(({ operationId }) => operationId)
  );
  const body = {
    ...requiredBody,
    operations: [
      ...(requiredBody.operations as AnyRecord[]),
      ...(absentBody.operations as AnyRecord[])
    ]
  };
  assertSampleAvailabilityProjection(body, probePlan);
  if (/https?:\/\/|providerId|endpoint|containerName/iu.test(JSON.stringify(body))) {
    throw new Error("Operation availability leaked internal Provider topology");
  }
}

async function signedAvailability(
  runtime: SampleRuntimeEnvironment,
  requestId: string,
  operations: string[]
): Promise<AnyRecord> {
  const headers = await signedHeaders(runtime, requestId, operations);
  const response = await fetch(`${sampleGatewayBaseUrl(runtime)}/v1/operation-availability`, {
    headers,
    signal: AbortSignal.timeout(30_000)
  });
  const body = await jsonResponse(response);
  if (!response.ok) throw new Error(`Signed operation availability failed: HTTP ${response.status}`);
  if (!Array.isArray(body.operations)) throw new Error("Operation availability response omitted operations");
  return body;
}

export function buildSampleAvailabilityProbePlan(
  deployments: readonly ControlledProviderDeployment[]
): SampleAvailabilityProbePlan {
  const runningProviderIds: string[] = [...SAMPLE_RUNTIME_PROVIDER_IDS].sort();
  const registeredProviderIds = deployments.map(({ providerId }) => providerId);
  const missingRunningProviders = runningProviderIds.filter((providerId) => !registeredProviderIds.includes(providerId));
  if (missingRunningProviders.length > 0) {
    throw new Error(`Full Gateway registry is missing sample runtime Providers: ${missingRunningProviders.join(", ")}`);
  }

  const operationOwners = new Map<string, string[]>();
  for (const deployment of deployments) {
    for (const capability of deployment.approvedManifest.capabilities) {
      const key = `${capability.operationId}@${capability.operationVersion}`;
      operationOwners.set(key, [...(operationOwners.get(key) ?? []), deployment.providerId]);
    }
  }
  for (const operationId of REQUIRED_SAMPLE_OPERATIONS) {
    const owners = operationOwners.get(`${operationId}@1.0`) ?? [];
    if (owners.length !== 1 || !runningProviderIds.includes(owners[0]!)) {
      throw new Error(`Required sample operation does not have one running Provider owner: ${operationId}@1.0`);
    }
  }

  const absentProviderProbes = deployments
    .filter(({ providerId }) => !runningProviderIds.includes(providerId))
    .sort((left, right) => left.providerId.localeCompare(right.providerId))
    .map((deployment) => {
      const capability = [...deployment.approvedManifest.capabilities]
        .sort((left, right) => `${left.operationId}@${left.operationVersion}`.localeCompare(
          `${right.operationId}@${right.operationVersion}`
        ))
        .find((candidate) => !["PLANNED", "RETIRED", "EXPERIMENTAL"].includes(candidate.maturity));
      if (!capability) throw new Error(`Absent sample Provider has no availability probe operation: ${deployment.providerId}`);
      return {
        providerId: deployment.providerId,
        operationId: capability.operationId,
        operationVersion: capability.operationVersion
      };
    });
  if (absentProviderProbes.length === 0) {
    throw new Error("Full Gateway registry does not retain any absent optional sample Providers");
  }
  return { requiredOperations: [...REQUIRED_SAMPLE_OPERATIONS], absentProviderProbes };
}

export function assertSampleAvailabilityProjection(
  body: AnyRecord,
  plan: SampleAvailabilityProbePlan
): void {
  const operations = body.operations;
  if (!Array.isArray(operations)) throw new Error("Operation availability response omitted operations");
  const expectedKeys = [
    ...plan.requiredOperations.map((operationId) => `${operationId}@1.0`),
    ...plan.absentProviderProbes.map(({ operationId, operationVersion }) => `${operationId}@${operationVersion}`)
  ].sort();
  const actualKeys = operations.map((entry: AnyRecord) =>
    `${String(entry.operationId)}@${String(entry.operationVersion)}`
  ).sort();
  if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys)) {
    throw new Error("Operation availability response differs from the exact sample probe set");
  }
  for (const operationId of plan.requiredOperations) {
    const entry = operations.find((candidate: AnyRecord) =>
      candidate.operationId === operationId && candidate.operationVersion === "1.0"
    ) as AnyRecord | undefined;
    if (entry?.availability !== "AVAILABLE") {
      throw new Error(`Required live operation is not AVAILABLE: ${operationId}@1.0`);
    }
  }
  for (const probe of plan.absentProviderProbes) {
    const entry = operations.find((candidate: AnyRecord) =>
      candidate.operationId === probe.operationId && candidate.operationVersion === probe.operationVersion
    ) as AnyRecord | undefined;
    if (entry?.availability !== "UNAVAILABLE") {
      throw new Error(`Absent sample Provider unexpectedly serves ${probe.operationId}@${probe.operationVersion}`);
    }
  }
}

async function inspectLiveDatabase(
  runtime: SampleRuntimeEnvironment,
  realization: SampleWorldRealization
): Promise<Omit<LiveSampleInstanceStatus, "requiredAvailable">> {
  const postgres = samplePostgresEndpoint(runtime);
  const pool = new Pool({
    host: postgres.host,
    port: postgres.port,
    database: runtime.values.POSTGRES_DB,
    user: "gowm_sample_loader_service",
    password: runtime.values.SAMPLE_LOADER_DB_PASSWORD,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000
  });
  try {
    const marker = await pool.query<{
      database_name: string;
      fixture_id: string;
      schema_version: string;
      allowed_data_scopes: string[];
    }>(`
      SELECT current_database() AS database_name,fixture_id,schema_version,allowed_data_scopes
      FROM gowm_sample_fixture.instance_marker
    `);
    const markerRow = marker.rows[0];
    if (marker.rows.length !== 1 || markerRow?.database_name !== "gowm_wsgs_sample" ||
        markerRow.fixture_id !== FIXTURE_ID || markerRow.schema_version !== FIXTURE_SCHEMA_VERSION ||
        canonicalJson(markerRow.allowed_data_scopes) !== canonicalJson([...EXPECTED_SCOPES])) {
      throw new Error("Live sample database marker mismatch");
    }

    const realizations = await pool.query<{ realization_id: string | null }>(`
      SELECT DISTINCT metadata->>'realizationId' AS realization_id
      FROM world_observation
      WHERE metadata->>'fixtureId'=$1
      ORDER BY realization_id
    `, [FIXTURE_ID]);
    if (realizations.rows.length !== 1 || realizations.rows[0]?.realization_id !== realization.fixture.realizationId) {
      throw new Error("Live database observations do not match the current realization");
    }

    const state = await pool.query<{
      state: AnyRecord;
      longitude: number;
      latitude: number;
      source_revision_no: number;
      realization_id: string | null;
    }>(`
      SELECT state.state,
             ST_X(geometry.geometry)::double precision AS longitude,
             ST_Y(geometry.geometry)::double precision AS latitude,
             observation.source_revision_no,
             observation.metadata->>'realizationId' AS realization_id
      FROM world_object object
      JOIN world_object_state state ON state.object_id=object.id
      JOIN world_object_geometry geometry ON geometry.object_id=object.id
      JOIN world_observation observation ON observation.observation_id=state.source_observation_id
      WHERE object.data_scope_key='wsgs-demo'
        AND object.properties->>'fixtureId'=$1
        AND object.properties->>'fixtureObjectKey'='ugv-002'
    `, [FIXTURE_ID]);
    const stateRow = state.rows[0];
    if (state.rows.length !== 1 || stateRow?.realization_id !== realization.fixture.realizationId) {
      throw new Error("Live UGV-002 state is absent or belongs to another realization");
    }
    const revision = classifyRevision(stateRow);
    const loadedStateHash = await sampleStateHash(pool);
    return {
      fixtureId: FIXTURE_ID,
      databaseMarker: "gowm_wsgs_sample/gowm-wsgs-sample-world/1.0",
      realizationId: realization.fixture.realizationId,
      revision,
      loadedStateHash
    };
  } finally {
    await pool.end();
  }
}

function classifyRevision(row: {
  state: AnyRecord;
  longitude: number;
  latitude: number;
  source_revision_no: number;
}): "v1" | "v2" {
  const near = (actual: number, expected: number): boolean => Math.abs(Number(actual) - expected) < 1e-9;
  if (Number(row.source_revision_no) === 1 && row.state.status === "AVAILABLE" &&
      Number(row.state.batteryPct) === 78 && near(row.longitude, 113.932) && near(row.latitude, 22.542)) {
    return "v1";
  }
  if (Number(row.source_revision_no) === 2 && row.state.status === "PATROLLING" &&
      Number(row.state.batteryPct) === 73 && near(row.longitude, 113.9355) && near(row.latitude, 22.545)) {
    return "v2";
  }
  throw new Error("Live UGV-002 state is neither the governed v1 nor v2 sample revision");
}

async function sampleStateHash(pool: pg.Pool): Promise<string> {
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
                ORDER BY data_scope_key,entity_kind,internal_id`, [[...EXPECTED_SCOPES]])
  ]);
  const value = { objects: objects.rows, features: features.rows, datasets: datasets.rows, references: references.rows };
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function signedHeaders(
  runtime: SampleRuntimeEnvironment,
  requestId: string,
  operations: string[]
): Promise<Record<string, string>> {
  const privateKey = await readFile(runtime.values.GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH!, "utf8");
  const now = Math.floor(Date.now() / 1_000);
  const claims: DelegationTokenClaims = {
    iss: runtime.values.GATEWAY_DELEGATION_ISSUER!,
    sub: runtime.values.GATEWAY_RUNTIME_PRINCIPAL_REF!,
    aud: runtime.values.GATEWAY_DELEGATION_AUDIENCE!,
    iat: now - 1,
    nbf: now - 1,
    exp: now + 120,
    jti: `sample-${randomUUID()}`,
    act: { sub: "actor:wsgs-integration" },
    requestId,
    delegationDepth: 1,
    dataScopes: [runtime.values.GATEWAY_DATA_SCOPE_CLAIM!],
    datasetScopes: [runtime.values.GATEWAY_DATASET_SCOPE_CLAIM!],
    allowedOperations: [...new Set(operations.map((operation) => `${operation}@1.0`))]
  };
  return {
    authorization: `Bearer ${runtime.values.GOWM_WSGS_SAMPLE_TOKEN}`,
    "x-request-id": requestId,
    "x-gowm-delegation": compactJws(claims, privateKey)
  };
}

function compactJws(claims: DelegationTokenClaims, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey).toString("base64url")}`;
}

async function jsonResponse(response: Response): Promise<AnyRecord> {
  const text = await response.text();
  try {
    return JSON.parse(text) as AnyRecord;
  } catch {
    throw new Error(`Gateway returned a non-JSON response: HTTP ${response.status}`);
  }
}

async function readJson(path: string): Promise<AnyRecord> {
  return JSON.parse(await readFile(path, "utf8")) as AnyRecord;
}
