import { getContractSchema, getContractSchemaHash, type CapabilityDescriptor, type CapabilityProviderManifest } from "../../../../packages/platform/contract-runtime/src/index.js";
import { createProviderRuntime, declaredSemanticProfile, ProviderProtocolError, sha256, type ProviderOperation, type ProviderOperationResult } from "../../../../packages/platform/provider-sdk/src/index.js";
import { ToolRegistry, type ToolDefinition } from "../../../stas/src/tools/registry.js";
import { AppError } from "../../../stas/src/domain/errors.js";
import type { AnalysisResult } from "../../../stas/src/domain/analysis.js";
import type { Database } from "../../../stas/src/db/database.js";
import profiles from "./semantic-profiles.stas.json" with { type: "json" };

export function stasDescriptor(tool: ToolDefinition): CapabilityDescriptor {
  const operationId = `stas.${tool.name.replaceAll("_", "-")}`;
  const inputSchemaUri = `urn:gowm:capability:${operationId}:input:1.0`, outputSchemaUri = "urn:gowm:capability:stas:output:1.0";
  const inputSchemaHash = getContractSchemaHash(inputSchemaUri), outputSchemaHash = getContractSchemaHash(outputSchemaUri);
  return {
    operationId, operationVersion: "1.0", semanticProfile: declaredSemanticProfile(profiles, operationId, "1.0"),
    semanticRole: "DOMAIN_ANALYSIS", dataBinding: "WORLD_SNAPSHOT_BOUND", resultSemantics: "DERIVED_ANALYSIS",
    executionBindings: ["SYNC_HTTP", "VERSIONED_SQL_CONTRACT"], criticalPathPolicy: "REMOTE_ONLY", maturity: "PREVIEW",
    inputSchemaUri, inputSchemaHash, outputSchemaUri, outputSchemaHash, scopePolicy: "DATA_SCOPE_REQUIRED",
    execution: { mode: "SYNC", defaultTimeoutMs: tool.defaultTimeoutMs, maximumTimeoutMs: tool.maxTimeoutMs, costClass: tool.costClass },
    limits: { maximumInputBytes: 1_048_576, maximumOutputBytes: 16_777_216, maximumRows: tool.maxRows, maximumCandidates: tool.maxCandidates ?? tool.maxRows },
    snapshotPolicy: { dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{ name: "request", schemaUri: inputSchemaUri, schemaHash: inputSchemaHash, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }],
      outputs: [{ name: "result", schemaUri: outputSchemaUri, schemaHash: outputSchemaHash, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }]
    }
  };
}

export interface StasNativeService { execute(name: string, input: unknown): Promise<AnalysisResult<unknown>> }
export function createStasProvider(database: Pick<Database, "withTransaction">, service: StasNativeService) {
  const operations: ProviderOperation[] = new ToolRegistry().list().map((tool) => {
    const descriptor = stasDescriptor(tool);
    return {
      descriptor, inputSchema: getContractSchema(descriptor.inputSchemaUri), outputSchema: getContractSchema(descriptor.outputSchemaUri),
      method: { engine: "MobilityDB", engineVersion: "1.3", methodId: descriptor.operationId, methodVersion: "1.0" },
      async handle(input, context): Promise<ProviderOperationResult<unknown>> {
        const parsed = tool.schema.safeParse(input);
        if (!parsed.success) throw new ProviderProtocolError("INVALID_REQUEST", "STAS input violates native refinements");
        const request = parsed.data as { dataScopeId: string; deadlineMs?: number } & Record<string, unknown>;
        const remaining = Math.floor(context.deadline.remainingMs());
        if (remaining < 1000) throw new ProviderProtocolError("DEADLINE_EXCEEDED", "STAS minimum execution budget is unavailable");
        try {
          // Authorize the native UUID against the gateway-attested tenant before any analysis.
          const authorized = await database.withTransaction(Math.min(remaining, 5000), "REPEATABLE_READ", async (tx) =>
            (await tx.query("SELECT data_scope_id FROM gowm_stas_v1.data_scope WHERE data_scope_id=$1::uuid AND tenant_key=$2::text", [request.dataScopeId, context.security.dataScopeClaim])).rows.length === 1);
          if (!authorized) throw new ProviderProtocolError("SCOPE_DENIED", "STAS data scope is not authorized");
          const budget = Math.min(request.deadlineMs ?? tool.defaultTimeoutMs, tool.maxTimeoutMs, Math.floor(context.deadline.remainingMs()));
          if (budget < 1000) throw new ProviderProtocolError("DEADLINE_EXCEEDED", "STAS execution budget exhausted after scope validation");
          const result = await service.execute(tool.name, { ...request, deadlineMs: budget });
          if (!result.snapshot.databaseSnapshotId) throw new ProviderProtocolError("SCHEMA_MISMATCH", "STAS result lacks its actual PostgreSQL snapshot identity");
          return {
            status: result.status === "COMPLETE" ? "COMPLETED" : result.status,
            value: result,
            dataSnapshot: {
              consistency: "PINNED", capturedAt: result.generatedAt, scopeDigest: sha256({ dataScopeKey: context.security.dataScopeClaim }),
              resources: [{ referenceKey: { namespace: "stas", kind: "DATA_SCOPE", id: result.snapshot.dataScopeId, version: result.snapshot.databaseSnapshotId }, authority: "gowm-stas-native-snapshot-v1", pinning: "PINNED", digest: sha256(result.snapshot) }]
            },
            warnings: result.warnings.map((w) => w.code),
            consumption: { rows: result.page?.returned ?? 1, candidates: result.execution.candidateCount ?? 0 }
          };
        } catch (error) {
          if (error instanceof ProviderProtocolError) throw error;
          if (error instanceof AppError) {
            const code = error.code === "DATA_SCOPE_FORBIDDEN" ? "SCOPE_DENIED" : error.code === "DEADLINE_EXCEEDED" ? "DEADLINE_EXCEEDED"
              : error.code === "DATABASE_UNAVAILABLE" || error.code === "SNAPSHOT_NOT_AVAILABLE" ? "PROVIDER_NOT_READY"
                : ["TOO_MANY_RESULTS", "TOO_MANY_CANDIDATES", "RESPONSE_TOO_LARGE", "QUERY_BUDGET_EXCEEDED"].includes(error.code) ? "BUDGET_EXCEEDED" : "INVALID_REQUEST";
            throw new ProviderProtocolError(code, "STAS native execution rejected the request", { retryable: code === "PROVIDER_NOT_READY", cause: error });
          }
          throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "STAS execution failed", { cause: error });
        }
      }
    };
  });
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0", manifestSchemaVersion: "1.1",
    provider: { providerId: "gowm.stas", providerVersion: "0.6.2", owner: "gowm-platform", implementationDigest: sha256({ adapter: "stas-protocol-1.0", native: "stas-native-1.0", descriptors: operations.map((o) => o.descriptor) }) },
    endpoints: { manifest: "/v1/manifest", liveness: "/health/live", readiness: "/health/ready", execute: "/v1/operations/{operationId}:execute", job: "/v1/jobs/{jobId}" },
    capabilities: operations.map((o) => o.descriptor)
  };
  const runtime = createProviderRuntime({ manifest, operations, policyVersion: "gowm-stas-provider/1.0", policyDigest: sha256({ scopeBeforeRead: true, nativeRefinements: true }) });
  return { runtime, async readiness() {
    try { await database.withTransaction(2000, "REPEATABLE_READ", (tx) => tx.runtimeMetadata()); return { ready: true, reasons: [] }; }
    catch { return { ready: false, reasons: ["STAS native read contract unavailable"] }; }
  } };
}
