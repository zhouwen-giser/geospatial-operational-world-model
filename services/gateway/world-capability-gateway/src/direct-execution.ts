import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  CapabilityResultEnvelope,
  GatewayExecuteRequest,
  ProviderExecutionRequest
} from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  validateCapabilityResultSemantics,
  validateContract
} from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  byteLength,
  newOpaqueId,
  ProviderProtocolError,
  sha256
} from "../../../../packages/platform/provider-sdk/src/index.js";
import type { AuditSink, GatewayPrincipal } from "./types.js";
import { ProviderCircuitBreaker } from "./circuit-breaker.js";
import type { GatewayIdempotencyStore } from "./idempotency.js";
import type { GatewayRecordStore } from "./records.js";
import { CapabilityRegistry } from "./registry.js";
import { principalContextHash } from "./principal-context.js";

const COST = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

export interface DirectExecutionOptions {
  registry: CapabilityRegistry;
  circuits: ProviderCircuitBreaker;
  idempotency: GatewayIdempotencyStore<CapabilityResultEnvelope>;
  audit: AuditSink;
  gatewayId: string;
  policyVersion: string;
  attestationIssuer: string;
  records?: GatewayRecordStore;
  now?: () => Date;
}

export class DirectExecutionService {
  readonly #now: () => Date;

  constructor(readonly options: DirectExecutionOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  async execute(
    operationId: string,
    publicRequest: GatewayExecuteRequest,
    principal: GatewayPrincipal
  ): Promise<{ result: CapabilityResultEnvelope; replayed: boolean }> {
    const started = performance.now();
    const requestHash = sha256(publicRequest);
    const eventBase = {
      occurredAt: this.#now().toISOString(),
      requestId: publicRequest.requestId,
      principalRef: principal.principalRef,
      operationId,
      operationVersion: publicRequest.operationVersion,
      inputHash: requestHash
    };
    try {
      this.#assertGatewayRequest(publicRequest);
      this.#assertPrincipal(principal);
      const route = this.options.registry.resolve(operationId, publicRequest.operationVersion, principal.allowExperimental ?? false);
      const descriptor = route.descriptor;
      if (descriptor.inputSchemaHash !== publicRequest.inputSchemaHash || descriptor.outputSchemaHash !== publicRequest.outputSchemaHash) {
        throw new ProviderProtocolError("SCHEMA_MISMATCH", "public request schema lock differs from the approved registry");
      }
      this.#assertPolicy(publicRequest, descriptor);
      this.#assertScope(descriptor.scopePolicy, principal);

      const scope = {
        principalHash: principalContextHash(principal),
        operationId,
        operationVersion: publicRequest.operationVersion
      };
      const idempotent = await this.options.idempotency.execute(scope, publicRequest.idempotencyKey, publicRequest, async () => {
        return this.options.circuits.execute(route.manifest.provider.providerId, () =>
          this.#withinDeadline(publicRequest.executionPolicy.deadlineAt, async () => {
          const health = await route.client.health(publicRequest.executionPolicy.deadlineAt);
          if (!health.ready) throw new ProviderProtocolError("PROVIDER_NOT_READY", `provider ${route.manifest.provider.providerId} is not ready`, { retryable: true });
          const providerRequest = this.#providerRequest(operationId, publicRequest, principal, descriptor.limits);
          const result = await route.client.execute(operationId, providerRequest);
          if (result.requestId !== providerRequest.requestId) {
            throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider result request identity differs from the controlled request");
          }
          this.#assertProviderResult(
            result,
            operationId,
            publicRequest,
            descriptor,
            route.manifest.provider
          );
            return result;
          })
        );
      });
      this.#assertProviderResult(
        idempotent.value,
        operationId,
        publicRequest,
        descriptor,
        route.manifest.provider
      );
      await this.options.audit.append({
        eventId: newOpaqueId("audit"),
        ...eventBase,
        providerId: route.manifest.provider.providerId,
        outcome: idempotent.replayed ? "REPLAYED" : "COMPLETED",
        outputHash: sha256(idempotent.value),
        elapsedMs: Math.max(0, performance.now() - started)
      });
      await this.options.records?.putResult(idempotent.value);
      return { result: idempotent.value, replayed: idempotent.replayed };
    } catch (error) {
      await this.options.audit.append({
        eventId: newOpaqueId("audit"),
        ...eventBase,
        outcome: "REJECTED",
        errorCode: error instanceof ProviderProtocolError ? error.code : "INTERNAL_GATEWAY_ERROR",
        elapsedMs: Math.max(0, performance.now() - started)
      });
      throw error;
    }
  }

  #assertGatewayRequest(value: GatewayExecuteRequest): void {
    const validation = validateContract("gateway-execute-request.schema.json", value);
    if (!validation.valid) {
      throw new ProviderProtocolError("INVALID_REQUEST", "Gateway request does not match the public contract", {
        details: { issues: validation.issues }
      });
    }
  }

  #assertPrincipal(principal: GatewayPrincipal): void {
    if (!principal.principalRef.trim() || !principal.authenticationMethod.trim() || !Number.isFinite(Date.parse(principal.authenticatedAt))) {
      throw new ProviderProtocolError("SCOPE_REQUIRED", "authenticated transport principal is required");
    }
  }

  #assertScope(policy: string, principal: GatewayPrincipal): void {
    if (policy === "DATA_SCOPE_REQUIRED" && !principal.dataScopeClaim?.trim()) {
      throw new ProviderProtocolError("SCOPE_REQUIRED", "operation requires a trusted data scope");
    }
    if (policy === "DATASET_SCOPE_REQUIRED" && !principal.datasetScopeClaim?.trim()) {
      throw new ProviderProtocolError("SCOPE_REQUIRED", "operation requires a trusted dataset scope");
    }
  }

  #assertPolicy(request: GatewayExecuteRequest, descriptor: {
    execution: { maximumTimeoutMs: number; costClass: "LOW" | "MEDIUM" | "HIGH" };
    limits: {
      maximumInputBytes?: number;
      maximumOutputBytes?: number;
      maximumRows?: number;
      maximumCandidates?: number;
    };
  }): void {
    const now = this.#now().getTime();
    const deadline = Date.parse(request.executionPolicy.deadlineAt);
    if (!Number.isFinite(deadline) || deadline <= now) {
      throw new ProviderProtocolError("DEADLINE_EXCEEDED", "Gateway request deadline has elapsed");
    }
    if (deadline - now > descriptor.execution.maximumTimeoutMs) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "requested deadline exceeds registered maximum timeout");
    }
    if (COST[request.executionPolicy.maximumCostClass] < COST[descriptor.execution.costClass]) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "operation cost class exceeds caller policy");
    }
    const inputBytes = byteLength(request.input);
    if (descriptor.limits.maximumInputBytes !== undefined && inputBytes > descriptor.limits.maximumInputBytes) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "input exceeds registered byte limit");
    }
    if (descriptor.limits.maximumOutputBytes !== undefined && request.executionPolicy.maximumResultBytes > descriptor.limits.maximumOutputBytes) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "requested output budget exceeds registered maximum");
    }
    if (
      descriptor.limits.maximumRows !== undefined &&
      request.executionPolicy.maximumRows !== undefined &&
      request.executionPolicy.maximumRows > descriptor.limits.maximumRows
    ) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "requested row budget exceeds registered maximum");
    }
    if (
      descriptor.limits.maximumCandidates !== undefined &&
      request.executionPolicy.maximumCandidates !== undefined &&
      request.executionPolicy.maximumCandidates > descriptor.limits.maximumCandidates
    ) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "requested candidate budget exceeds registered maximum");
    }
  }

  #providerRequest(
    operationId: string,
    request: GatewayExecuteRequest,
    principal: GatewayPrincipal,
    limits: {
      maximumInputBytes?: number;
      maximumRows?: number;
      maximumCandidates?: number;
      maximumVertices?: number;
      maximumCells?: number;
      maximumBatchItems?: number;
    }
  ): ProviderExecutionRequest {
    const issuedAt = this.#now();
    const expiresAt = new Date(Math.min(Date.parse(request.executionPolicy.deadlineAt), issuedAt.getTime() + 300_000));
    const maximumRows = effectiveLimit(limits.maximumRows, request.executionPolicy.maximumRows);
    const maximumCandidates = effectiveLimit(limits.maximumCandidates, request.executionPolicy.maximumCandidates);
    return {
      providerProtocolVersion: "1.0",
      requestId: newOpaqueId("provider-request"),
      gatewayRequestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      operation: {
        operationId,
        operationVersion: request.operationVersion,
        inputSchemaHash: request.inputSchemaHash,
        outputSchemaHash: request.outputSchemaHash
      },
      input: request.input,
      securityContext: {
        principalRef: principal.principalRef,
        authenticationMethod: principal.authenticationMethod,
        authenticatedAt: principal.authenticatedAt,
        ...(principal.dataScopeClaim === undefined ? {} : { dataScopeClaim: principal.dataScopeClaim }),
        ...(principal.datasetScopeClaim === undefined ? {} : { datasetScopeClaim: principal.datasetScopeClaim }),
        scopeAttestation: {
          issuer: this.options.attestationIssuer,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          claimDigest: sha256({
            principalRef: principal.principalRef,
            dataScopeClaim: principal.dataScopeClaim ?? null,
            datasetScopeClaim: principal.datasetScopeClaim ?? null,
            gatewayRequestId: request.requestId
          })
        }
      },
      gatewayContext: {
        gatewayId: this.options.gatewayId,
        registryVersion: this.options.registry.revision,
        policyVersion: this.options.policyVersion
      },
      executionPolicy: {
        deadlineAt: request.executionPolicy.deadlineAt,
        maximumInputBytes: limits.maximumInputBytes ?? Math.max(1, byteLength(request.input)),
        maximumResultBytes: request.executionPolicy.maximumResultBytes,
        ...(maximumRows === undefined ? {} : { maximumRows }),
        ...(maximumCandidates === undefined ? {} : { maximumCandidates }),
        ...(limits.maximumVertices === undefined ? {} : { maximumVertices: limits.maximumVertices }),
        ...(limits.maximumCells === undefined ? {} : { maximumCells: limits.maximumCells }),
        ...(limits.maximumBatchItems === undefined ? {} : { maximumBatchItems: limits.maximumBatchItems }),
        maximumCostClass: request.executionPolicy.maximumCostClass
      }
    };
  }

  async #withinDeadline<T>(deadlineAt: string, action: () => Promise<T>): Promise<T> {
    const remainingMs = Math.floor(Date.parse(deadlineAt) - this.#now().getTime());
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw new ProviderProtocolError("DEADLINE_EXCEEDED", "Gateway request deadline elapsed before Provider execution");
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ProviderProtocolError(
        "DEADLINE_EXCEEDED",
        "Gateway Provider path exceeded the caller deadline"
      )), remainingMs);
      timer.unref();
    });
    try {
      return await Promise.race([action(), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #assertProviderResult(
    result: CapabilityResultEnvelope,
    operationId: string,
    request: GatewayExecuteRequest,
    descriptor: CapabilityDescriptor,
    provider: CapabilityProviderManifest["provider"]
  ): void {
    const validation = validateContract("capability-result-envelope.schema.json", result);
    if (!validation.valid) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider result fails the platform envelope contract", {
        details: { issues: validation.issues }
      });
    }
    if (result.operation.operationId !== operationId || result.operation.operationVersion !== request.operationVersion) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider result operation identity differs from the request");
    }
    const semantics = validateCapabilityResultSemantics(result, descriptor);
    if (!semantics.valid) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider result fails platform semantic validation", {
        details: { issues: semantics.issues }
      });
    }
    if (
      result.execution.providerId !== provider.providerId ||
      result.execution.providerVersion !== provider.providerVersion ||
      result.computeSnapshot.provider.providerId !== provider.providerId ||
      result.computeSnapshot.provider.providerVersion !== provider.providerVersion ||
      result.computeSnapshot.provider.implementationDigest !== provider.implementationDigest
    ) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider result identity differs from the controlled registry route");
    }
    if (
      result.output && (
        result.output.schemaUri !== descriptor.outputSchemaUri ||
        result.output.schemaHash !== request.outputSchemaHash
      )
    ) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider result output schema identity differs from the registry lock");
    }
    if (
      result.output !== undefined &&
      byteLength(result.output.value) > request.executionPolicy.maximumResultBytes
    ) {
      throw new ProviderProtocolError(
        "BUDGET_EXCEEDED",
        "provider result exceeds the caller-attested output budget",
        {
          details: {
            metric: "outputBytes",
            consumed: byteLength(result.output.value),
            limit: request.executionPolicy.maximumResultBytes
          }
        }
      );
    }
    this.#assertReportedBudget(
      "rows",
      result.consumption.rows,
      effectiveLimit(descriptor.limits.maximumRows, request.executionPolicy.maximumRows)
    );
    this.#assertReportedBudget(
      "candidates",
      result.consumption.candidates,
      effectiveLimit(descriptor.limits.maximumCandidates, request.executionPolicy.maximumCandidates)
    );
    const inputHash = sha256(request.input);
    for (const receipt of result.receipts) {
      if (
        receipt.inputHash !== inputHash ||
        receipt.operationId !== operationId ||
        receipt.operationVersion !== request.operationVersion ||
        receipt.providerId !== provider.providerId ||
        receipt.providerVersion !== provider.providerVersion
      ) {
        throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider receipt identity differs from the controlled request");
      }
    }
  }

  #assertReportedBudget(
    metric: "rows" | "candidates",
    consumed: number | undefined,
    limit: number | undefined
  ): void {
    if (limit === undefined) return;
    if (consumed === undefined) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", `provider omitted required ${metric} consumption`);
    }
    if (consumed > limit) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", `provider result exceeds the caller-attested ${metric} budget`, {
        details: { metric, consumed, limit }
      });
    }
  }
}

function effectiveLimit(registered: number | undefined, requested: number | undefined): number | undefined {
  if (registered === undefined) return requested;
  if (requested === undefined) return registered;
  return Math.min(registered, requested);
}
