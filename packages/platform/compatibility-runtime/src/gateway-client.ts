import { randomUUID } from "node:crypto";
import type {
  CapabilityDescriptor,
  CapabilityResultEnvelope,
  GatewayExecuteRequest
} from "../../contract-runtime/src/index.js";
import {
  assertAgainstSchema,
  assertContract,
  canonicalSha256,
  getContractSchema
} from "../../contract-runtime/src/index.js";

export const CONTROLLED_COMPATIBILITY_OPERATIONS = [
  "spatial.find-nearby",
  "spatial.find-nearest",
  "spatial.find-in-area",
  "spatial.find-intersections",
  "spatial.find-near-route",
  "spatial.summarize-area",
  "gowm.situation.h3.get-cell",
  "gowm.situation.h3.get-area",
  "gowm.situation.h3.get-hotspots",
  "gowm.situation.h3.get-coverage-gaps"
] as const;

export type ControlledCompatibilityOperation = (typeof CONTROLLED_COMPATIBILITY_OPERATIONS)[number];

export interface GatewayTransportContext {
  requestId?: string;
  authorization?: string;
  dataScopeClaim?: string;
}

export interface GatewayOperationClient {
  execute(
    operationId: ControlledCompatibilityOperation,
    input: unknown,
    context?: GatewayTransportContext
  ): Promise<CapabilityResultEnvelope>;
}

export interface HttpGatewayOperationClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  maximumResultBytes?: number;
}

/**
 * Fixed-operation Gateway client. Capability detail is used only to obtain the
 * authoritative schema locks for an allowlisted operation; it never registers
 * or trusts dynamically discovered tools.
 */
export class HttpGatewayOperationClient implements GatewayOperationClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maximumResultBytes: number;
  private readonly descriptorCache = new Map<ControlledCompatibilityOperation, CapabilityDescriptor>();

  constructor(options: HttpGatewayOperationClientOptions) {
    this.baseUrl = safeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, "timeoutMs");
    this.maximumResultBytes = positiveInteger(options.maximumResultBytes ?? 16_777_216, "maximumResultBytes");
  }

  async execute(
    operationId: ControlledCompatibilityOperation,
    input: unknown,
    context: GatewayTransportContext = {}
  ): Promise<CapabilityResultEnvelope> {
    assertControlledOperation(operationId);
    const descriptor = await this.descriptor(operationId, context);
    const requestId = identifier(context.requestId) ?? `compat_${randomUUID()}`;
    const deadlineAt = new Date(this.now().getTime() + Math.min(this.timeoutMs, descriptor.execution.maximumTimeoutMs)).toISOString();
    const request: GatewayExecuteRequest = {
      requestVersion: "1.0",
      requestId,
      idempotencyKey: `compat:${canonicalSha256({ operationId, input, requestId }).slice("sha256:".length)}`,
      operationVersion: descriptor.operationVersion,
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash,
      input,
      executionPolicy: {
        deadlineAt,
        maximumResultBytes: Math.min(this.maximumResultBytes, descriptor.limits.maximumOutputBytes ?? this.maximumResultBytes),
        maximumCostClass: descriptor.execution.costClass,
        preferredExecution: "SYNC"
      },
      snapshotRequest: {
        consistency: operationId.startsWith("gowm.situation.") ? "BEST_EFFORT" : "CONSISTENT_AT_START"
      }
    };
    assertContract<GatewayExecuteRequest>("urn:gowm:v0.2:gateway-execute-request", request);
    const response = await this.fetchImpl(this.url(`/v1/operations/${encodeURIComponent(operationId)}:execute`), {
      method: "POST",
      headers: transportHeaders(context, true),
      body: JSON.stringify(request)
    });
    const data = await responseJson(response);
    if (!response.ok) throw new GatewayCompatibilityError(response.status, "Gateway operation failed", data);
    assertContract<CapabilityResultEnvelope>("urn:gowm:v0.2:capability-result-envelope", data);
    if (data.operation.operationId !== operationId || data.operation.operationVersion !== descriptor.operationVersion) {
      throw new Error("Gateway returned a result for a different operation");
    }
    if (data.output && data.output.schemaHash !== descriptor.outputSchemaHash) {
      throw new Error("Gateway output schema lock differs from the resolved capability");
    }
    if (data.status === "FAILED" || data.status === "INDETERMINATE") {
      throw new Error(`Gateway operation did not complete: ${data.status}`);
    }
    return data;
  }

  private async descriptor(
    operationId: ControlledCompatibilityOperation,
    context: GatewayTransportContext
  ): Promise<CapabilityDescriptor> {
    const cached = this.descriptorCache.get(operationId);
    if (cached) return cached;
    const response = await this.fetchImpl(this.url(`/v1/capabilities/${encodeURIComponent(operationId)}`), {
      method: "GET",
      headers: transportHeaders(context, false)
    });
    const data = await responseJson(response);
    if (!response.ok) throw new GatewayCompatibilityError(response.status, "Gateway capability resolution failed", data);
    if (!isRecord(data) || !Array.isArray(data.versions)) throw new Error("Gateway capability detail is malformed");
    const candidates = data.versions.filter((value): value is CapabilityDescriptor =>
      isRecord(value) && value.operationId === operationId && value.operationVersion === "1.0"
    );
    if (candidates.length !== 1) throw new Error("Gateway capability detail must contain exactly one controlled v1.0 descriptor");
    const descriptor = candidates[0] as CapabilityDescriptor;
    assertAgainstSchema<CapabilityDescriptor>(
      getContractSchema("urn:gowm:v0.2:capability-descriptor"),
      descriptor,
      { schemaName: "urn:gowm:v0.2:capability-descriptor" }
    );
    if (["PLANNED", "RETIRED"].includes(descriptor.maturity)) throw new Error("Gateway capability is not executable");
    this.descriptorCache.set(operationId, descriptor);
    return descriptor;
  }

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }
}

export class GatewayCompatibilityError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly response: unknown
  ) {
    super(`${message} (${statusCode})`);
    this.name = "GatewayCompatibilityError";
  }
}

function assertControlledOperation(value: string): asserts value is ControlledCompatibilityOperation {
  if (!(CONTROLLED_COMPATIBILITY_OPERATIONS as readonly string[]).includes(value)) {
    throw new Error(`Operation is not allowed by the compatibility client: ${value}`);
  }
}

function safeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Gateway base URL must be an HTTP(S) origin without credentials, query or fragment");
  }
  return url;
}

function transportHeaders(context: GatewayTransportContext, json: boolean): Record<string, string> {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    ...(context.authorization ? { authorization: context.authorization } : {}),
    ...(context.dataScopeClaim ? { "x-gowm-data-scope": context.dataScopeClaim } : {}),
    ...(identifier(context.requestId) ? { "x-request-id": context.requestId as string } : {})
  };
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayCompatibilityError(response.status, "Gateway returned non-JSON data", text.slice(0, 256));
  }
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u.test(value) ? value : undefined;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

