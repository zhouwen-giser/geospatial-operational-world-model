import {
  getContractSchema,
  getContractSchemaHash,
  type CapabilityDescriptor,
  type CapabilityProviderManifest,
  type DataSnapshotContext
} from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  ProviderProtocolError,
  sha256,
  type ProviderOperation,
  type ProviderRuntime
} from "../../../../packages/platform/provider-sdk/src/index.js";
import {
  validateDataSnapshot,
  validateReferenceRecord,
  type DataSnapshotManifest,
  type ReferenceRecord,
  type SnapshotResource
} from "../../../../packages/platform/result-validation-core/src/index.js";

type JsonObject = Record<string, unknown>;
type ValidationRequest = { referenceKey: ReferenceRecord["referenceKey"]; maximumAgeMs?: number; requireCurrentSnapshot?: boolean };
type Scope = { dataScopeKey: string; datasetScopeKey?: string };

export interface PlatformValidationAuthority {
  resolveReferences(requests: readonly ValidationRequest[], scope: Scope): Promise<Array<ReferenceRecord | undefined>>;
  getSnapshot(snapshotId: string, scope: Scope): Promise<DataSnapshotManifest | undefined>;
  currentResources(resources: readonly SnapshotResource[], scope: Scope): Promise<ReadonlyMap<string, SnapshotResource | "UNAVAILABLE">>;
}

export interface PlatformValidationProvider { runtime: ProviderRuntime; authority: PlatformValidationAuthority }

export { PostgresPlatformValidationAuthority } from "./postgres-authority.js";

const operations = ["result.validate", "snapshot.get", "snapshot.validate"] as const;
type OperationId = (typeof operations)[number];
const statusMapping = {
  SUCCEEDED: "COMPLETED", COMPLETED: "COMPLETED", PARTIAL: "PARTIAL", NO_DATA: "NO_DATA", AMBIGUOUS: "AMBIGUOUS",
  INDETERMINATE: "INDETERMINATE", NO_PATH: "NO_FEASIBLE_RESULT", NO_FEASIBLE_PLAN: "NO_FEASIBLE_RESULT", STALE: "STALE", FAILED: "FAILED"
} as const;

export function createPlatformValidationProvider(authority: PlatformValidationAuthority, now: () => Date = () => new Date()): PlatformValidationProvider {
  const providerOperations = operations.map((operationId) => operation(operationId, authority, now));
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0",
    provider: {
      providerId: "gowm.platform-validation", providerVersion: "1.0.0", owner: "gowm-platform",
      implementationDigest: sha256({ provider: "gowm.platform-validation", version: "1.0.0", operations: providerOperations.map(({ descriptor }) => descriptor) }),
      sourceRef: "urn:gowm:source:in-tree:platform-validation-provider:1.0.0"
    },
    endpoints: { manifest: "/v1/manifest", liveness: "/health/live", readiness: "/health/ready", execute: "/v1/operations/{operationId}:execute", job: "/v1/jobs/{jobId}" },
    capabilities: providerOperations.map(({ descriptor }) => descriptor)
  };
  return {
    authority,
    runtime: createProviderRuntime({ manifest, operations: providerOperations, policyVersion: "gowm-platform-validation-policy/1.0", policyDigest: sha256({ scopeBeforeRead: true, readOnly: true, noAutomaticRecompute: true }), now })
  };
}

function operation(operationId: OperationId, authority: PlatformValidationAuthority, now: () => Date): ProviderOperation {
  const [inputName, outputName] = operationId === "result.validate" ? ["result-validation-request", "result-validation-result"]
    : operationId === "snapshot.get" ? ["snapshot-get-request", "data-snapshot-manifest"]
      : ["snapshot-validation-request", "snapshot-validation-result"];
  const inputSchemaUri = `urn:gowm:v0.6.1:${inputName}`, outputSchemaUri = `urn:gowm:v0.6.1:${outputName}`;
  const descriptor: CapabilityDescriptor = {
    operationId, operationVersion: "1.0", semanticRole: "FOUNDATION_DATA_QUERY", dataBinding: "WORLD_SNAPSHOT_BOUND", resultSemantics: "VALIDATION",
    executionBindings: ["SYNC_HTTP", "VERSIONED_SQL_CONTRACT"], criticalPathPolicy: "REMOTE_ONLY", maturity: "STABLE",
    inputSchemaUri, inputSchemaHash: getContractSchemaHash(inputSchemaUri), outputSchemaUri, outputSchemaHash: getContractSchemaHash(outputSchemaUri),
    scopePolicy: "DATA_SCOPE_REQUIRED", execution: { mode: "SYNC", defaultTimeoutMs: 5_000, maximumTimeoutMs: 30_000, costClass: "LOW" },
    limits: { maximumInputBytes: 1_048_576, maximumOutputBytes: 4_194_304, maximumRows: 512, maximumCandidates: 512, maximumBatchItems: 512 },
    snapshotPolicy: { dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{ name: "request", schemaUri: inputSchemaUri, schemaHash: getContractSchemaHash(inputSchemaUri), valueKind: "ANY", unitSemantics: "UNSPECIFIED" }],
      outputs: [{ name: "result", schemaUri: outputSchemaUri, schemaHash: getContractSchemaHash(outputSchemaUri), valueKind: operationId === "result.validate" ? "ROW_SET" : "ANY", unitSemantics: "UNSPECIFIED" }]
    }
  };
  return {
    descriptor, inputSchema: getContractSchema(inputSchemaUri), outputSchema: getContractSchema(outputSchemaUri),
    method: { engine: "GOWM Platform Validation", engineVersion: "1.0.0", methodId: `gowm-platform-validation/${operationId}`, methodVersion: "1.0", artifacts: [{ kind: "PACKAGE", name: "result-validation-core", version: "0.6.1" }] },
    async handle(inputValue, context) {
      const input = inputValue as JsonObject;
      const scope = trustedScope(context.security.dataScopeClaim, context.security.datasetScopeClaims?.[0]);
      const capturedAt = now().toISOString();
      if (operationId === "result.validate") {
        const requests = (input.references as ValidationRequest[]);
        const records = await authority.resolveReferences(requests, scope);
        const results = requests.map((request, index) => validateReferenceRecord(records[index], request, statusMapping, now()));
        return completed({ schemaVersion: "1.0", results }, scope, capturedAt, results.length);
      }
      if (operationId === "snapshot.get") {
        const snapshot = await authority.getSnapshot(requiredString(input.snapshotId, "snapshotId"), scope);
        if (snapshot === undefined) return { status: "NO_DATA", dataSnapshot: dataContext(scope, capturedAt), consumption: { rows: 0, candidates: 0 }, warnings: ["Snapshot is unavailable in the authorized scope"] };
        return completed(snapshot, scope, capturedAt, snapshot.resources.length);
      }
      const snapshot = input.snapshot as DataSnapshotManifest;
      const current = await authority.currentResources(snapshot.resources, scope);
      return completed(validateDataSnapshot(snapshot, current, capturedAt), scope, capturedAt, snapshot.resources.length);
    }
  };
}

function completed(value: unknown, scope: Scope, capturedAt: string, rows: number) {
  return { status: "COMPLETED" as const, value, dataSnapshot: dataContext(scope, capturedAt), consumption: { rows, candidates: rows }, warnings: [], changes: { repairApplied: false, typeChanged: false } };
}
function dataContext(scope: Scope, capturedAt: string): DataSnapshotContext {
  const identity = sha256(scope);
  return { consistency: "CONSISTENT_AT_START", capturedAt, scopeDigest: identity, resources: [{ referenceKey: { namespace: "gowm", kind: "DATASET", id: `wrf_${identity.slice(7, 39)}`, version: "1" }, authority: "gowm.platform-validation", pinning: "AT_LEAST", digest: identity }] };
}
function trustedScope(dataScopeKey?: string, datasetScopeKey?: string): Scope {
  if (dataScopeKey === undefined || dataScopeKey.trim() === "") throw new ProviderProtocolError("SCOPE_REQUIRED", "platform validation requires a data scope");
  return { dataScopeKey, ...(datasetScopeKey === undefined ? {} : { datasetScopeKey }) };
}
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0) throw new ProviderProtocolError("INVALID_REQUEST", `${name} is required`); return value; }
