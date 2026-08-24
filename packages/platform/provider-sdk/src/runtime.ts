import type {
  CapabilityResultEnvelope,
  ComputeSnapshotContext,
  ExecutionReceipt,
  ProviderExecutionRequest
} from "../../contract-runtime/src/index.js";
import { validateAgainstSchema, validateContract } from "../../contract-runtime/src/index.js";
import {
  assertWithinBudget,
  inputConsumption,
  intersectLimits,
  outputConsumption,
  type ResourceConsumption
} from "./budget.js";
import { newOpaqueId, sha256 } from "./canonical.js";
import { runWithDeadline } from "./deadline.js";
import { ProviderProtocolError, mapProviderError } from "./errors.js";
import { IdempotencyCache } from "./idempotency.js";
import { assertManifestMatchesOperations } from "./manifest.js";
import { assertTrustedScope, type TrustedSecurityContext } from "./scope.js";
import { createTraceContext } from "./trace.js";
import type { ProviderOperation, ProviderOperationResult, ProviderRuntime, ProviderRuntimeOptions } from "./types.js";

function operationKey(operationId: string, operationVersion: string): string {
  return `${operationId}@${operationVersion}`;
}

function trustedSecurity(request: ProviderExecutionRequest): TrustedSecurityContext {
  return {
    principalRef: request.securityContext.principalRef,
    ...(request.securityContext.dataScopeClaim === undefined ? {} : { dataScopeClaim: request.securityContext.dataScopeClaim }),
    ...(request.securityContext.datasetScopeClaim === undefined ? {} : { datasetScopeClaims: [request.securityContext.datasetScopeClaim] })
  };
}

export function createProviderRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
  assertManifestMatchesOperations(options.manifest, options.operations);
  const operationMap = new Map(options.operations.map((operation) => [
    operationKey(operation.descriptor.operationId, operation.descriptor.operationVersion),
    operation
  ]));
  const cache = new IdempotencyCache<CapabilityResultEnvelope>(options.maximumIdempotencyEntries);
  const now = options.now ?? (() => new Date());
  const receiptId = options.receiptId ?? (() => newOpaqueId("receipt"));
  const provider = options.manifest.provider;

  const execute = async (request: ProviderExecutionRequest, traceId?: string): Promise<CapabilityResultEnvelope> => {
    try {
      assertNamedSchema("provider-execution-request.schema.json", request, "INVALID_REQUEST");
      const key = operationKey(request.operation.operationId, request.operation.operationVersion);
      const operation = operationMap.get(key);
      if (!operation) throw new ProviderProtocolError("OPERATION_NOT_FOUND", `provider does not expose ${key}`);
      if (request.operation.inputSchemaHash !== operation.descriptor.inputSchemaHash ||
          request.operation.outputSchemaHash !== operation.descriptor.outputSchemaHash) {
        throw new ProviderProtocolError("SCHEMA_MISMATCH", `schema lock mismatch for ${key}`);
      }
      assertOperationSchema(operation.inputSchema, request.input, "input");
      const security = trustedSecurity(request);
      assertTrustedScope(operation.descriptor.scopePolicy, security);
      assertCostClass(operation.descriptor.execution.costClass, request.executionPolicy.maximumCostClass);
      const limits = intersectLimits(operation.descriptor.limits, request.executionPolicy);
      assertWithinBudget(limits, inputConsumption(request.input));

      return await cache.execute(request.idempotencyKey, {
        operation: request.operation,
        input: request.input,
        principalRef: request.securityContext.principalRef,
        ...(request.securityContext.dataScopeClaim === undefined ? {} : { dataScopeClaim: request.securityContext.dataScopeClaim }),
        ...(request.securityContext.datasetScopeClaim === undefined ? {} : { datasetScopeClaim: request.securityContext.datasetScopeClaim })
      }, async () => {
        const started = performance.now();
        const result = await runWithDeadline(request.executionPolicy.deadlineAt, (deadline) => operation.handle(
          request.input,
          { security, deadline, trace: createTraceContext(request.requestId, traceId) }
        ), () => now().getTime());
        return assembleResult(operation, request, result, {
          providerId: provider.providerId,
          providerVersion: provider.providerVersion,
          ...(provider.implementationDigest === undefined ? {} : { implementationDigest: provider.implementationDigest })
        }, options.policyVersion, options.policyDigest, receiptId(), now(), performance.now() - started, limits);
      });
    } catch (error) {
      throw mapProviderError(error);
    }
  };

  return {
    manifest: structuredClone(options.manifest),
    execute,
    health: () => ({ live: true, providerId: provider.providerId, providerVersion: provider.providerVersion }),
    readiness: () => ({ ready: true, providerId: provider.providerId, operationCount: operationMap.size, reasons: [] })
  };
}

const COST_CLASS = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

function assertCostClass(
  operationCost: keyof typeof COST_CLASS,
  maximumCost: keyof typeof COST_CLASS
): void {
  if (COST_CLASS[operationCost] > COST_CLASS[maximumCost]) {
    throw new ProviderProtocolError("BUDGET_EXCEEDED", "operation cost class exceeds the attested provider budget");
  }
}

function assembleResult(
  operation: ProviderOperation,
  request: ProviderExecutionRequest,
  result: ProviderOperationResult<unknown>,
  provider: { providerId: string; providerVersion: string; implementationDigest?: string },
  policyVersion: string,
  policyDigest: `sha256:${string}`,
  receiptId: string,
  generatedAt: Date,
  elapsedMs: number,
  limits: Parameters<typeof assertWithinBudget>[0]
): CapabilityResultEnvelope {
  const descriptor = operation.descriptor;
  if ((result.status === "COMPLETED" || result.status === "PARTIAL") && result.value === undefined) {
    throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${result.status} result requires output`);
  }
  if (result.value !== undefined) assertOperationSchema(operation.outputSchema, result.value, "output");
  const consumption: ResourceConsumption & { outputBytes: number } = {
    ...inputConsumption(request.input),
    ...result.consumption,
    outputBytes: result.value === undefined ? 0 : (outputConsumption(result.value).outputBytes ?? 0)
  };
  assertReportedNodeConsumption(request, consumption);
  assertWithinBudget(limits, consumption);

  const dataBound = descriptor.dataBinding === "WORLD_SNAPSHOT_BOUND" || descriptor.dataBinding === "DATASET_VERSION_BOUND";
  if (dataBound && descriptor.snapshotPolicy.dataSnapshot === "REQUIRED" && result.dataSnapshot === undefined) {
    throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "data-bound result requires a data snapshot");
  }
  if (!dataBound && result.dataSnapshot !== undefined) {
    throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "world-independent result must not fabricate a data snapshot");
  }
  if (!dataBound && (result.evidenceReferences?.length ?? 0) > 0) {
    throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "generic computation must not fabricate world evidence");
  }

  const computeSnapshot: ComputeSnapshotContext = {
    provider,
    operation: { operationId: descriptor.operationId, operationVersion: descriptor.operationVersion },
    engine: {
      name: operation.method.engine,
      version: operation.method.engineVersion,
      ...(operation.method.engineDigest === undefined ? {} : { digest: operation.method.engineDigest })
    },
    policy: { version: policyVersion, digest: policyDigest },
    schemas: { inputSchemaHash: descriptor.inputSchemaHash, outputSchemaHash: descriptor.outputSchemaHash },
    ...(operation.method.artifacts === undefined ? {} : { artifacts: [...operation.method.artifacts] })
  };
  const outputHash = sha256(result.value ?? null);
  const receipt: ExecutionReceipt = {
    receiptId,
    operationId: descriptor.operationId,
    operationVersion: descriptor.operationVersion,
    providerId: provider.providerId,
    providerVersion: provider.providerVersion,
    inputHash: sha256(request.input),
    outputHash,
    computeSnapshotHash: sha256(computeSnapshot),
    generatedAt: generatedAt.toISOString(),
    durationMs: Math.max(0, elapsedMs),
    method: {
      engine: operation.method.engine,
      engineVersion: operation.method.engineVersion,
      methodId: operation.method.methodId,
      methodVersion: operation.method.methodVersion
    },
    changes: result.changes ?? { repairApplied: false, typeChanged: false },
    warnings: [...(result.warnings ?? [])]
  };
  const envelope: CapabilityResultEnvelope = {
    providerProtocolVersion: "1.0",
    requestId: request.requestId,
    operation: { operationId: descriptor.operationId, operationVersion: descriptor.operationVersion },
    status: result.status,
    ...(result.value === undefined ? {} : {
      output: { schemaUri: descriptor.outputSchemaUri, schemaHash: descriptor.outputSchemaHash, value: result.value }
    }),
    ...(result.dataSnapshot === undefined ? {} : { dataSnapshot: result.dataSnapshot }),
    computeSnapshot,
    receipts: [receipt],
    evidenceReferences: [...(result.evidenceReferences ?? [])],
    warnings: [...(result.warnings ?? [])],
    consumption,
    execution: {
      providerId: provider.providerId,
      providerVersion: provider.providerVersion,
      elapsedMs: Math.max(0, elapsedMs)
    }
  };
  envelope.execution.resultHash = outputHash;
  assertNamedSchema("capability-result-envelope.schema.json", envelope, "INTERNAL_PROVIDER_ERROR");
  return envelope;
}

function assertReportedNodeConsumption(
  request: ProviderExecutionRequest,
  consumption: ResourceConsumption
): void {
  for (const [limitKey, usageKey] of [
    ["maximumRows", "rows"],
    ["maximumCandidates", "candidates"]
  ] as const) {
    if (request.executionPolicy[limitKey] !== undefined && consumption[usageKey] === undefined) {
      throw new ProviderProtocolError(
        "INTERNAL_PROVIDER_ERROR",
        `provider did not report ${usageKey} required by the attested execution policy`
      );
    }
  }
}

function assertNamedSchema(
  name: string,
  value: unknown,
  code: "INVALID_REQUEST" | "INTERNAL_PROVIDER_ERROR"
): void {
  const result = validateContract(name, value);
  if (!result.valid) {
    throw new ProviderProtocolError(code, `${name} validation failed`, { details: { issues: result.issues } });
  }
}

function assertOperationSchema(schema: Readonly<Record<string, unknown>>, value: unknown, direction: "input" | "output"): void {
  const result = validateAgainstSchema(schema, value);
  if (!result.valid) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", `operation ${direction} schema validation failed`, {
      details: { issues: result.issues }
    });
  }
}
