import type {
  CapabilityProviderManifest,
  CapabilityResultEnvelope,
  ProviderExecutionRequest
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { validateContract } from "../../../../packages/platform/contract-runtime/src/index.js";
import { validateProviderManifestSemantics } from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  PROVIDER_ERROR_CODES,
  ProviderProtocolError,
  sha256,
  type ProviderErrorCode
} from "../../../../packages/platform/provider-sdk/src/index.js";
import type { ProviderClient, ProviderHealth } from "./types.js";
import { assertControlledProviderEndpoint } from "./registry.js";

const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;

export interface HttpProviderClientOptions {
  endpoint: URL;
  providerId: string;
  providerVersion: string;
  implementationDigest: `sha256:${string}`;
  manifestHash: `sha256:${string}`;
  approvedManifest: CapabilityProviderManifest;
  manifestPath?: string;
  transportToken: string;
  controlTimeoutMs?: number;
  maximumResponseBytes?: number;
  allowPlaintextPrivateNetwork?: boolean;
  fetch?: typeof globalThis.fetch;
}

/**
 * Provider Protocol HTTP client for Registry-approved origins. All paths come
 * from the attested manifest and fetch redirects are forbidden, so neither a
 * caller payload nor a provider redirect can select an alternate destination.
 */
export class HttpProviderClient implements ProviderClient {
  readonly providerId: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #controlTimeoutMs: number;
  readonly #maximumResponseBytes: number;

  constructor(readonly options: HttpProviderClientOptions) {
    this.providerId = options.providerId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#controlTimeoutMs = positiveInteger(options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS, "controlTimeoutMs");
    this.#maximumResponseBytes = positiveInteger(options.maximumResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, "maximumResponseBytes");
    if (Buffer.byteLength(options.transportToken, "utf8") < 32) throw new TypeError("provider transport token must contain at least 32 bytes");
    assertControlledProviderEndpoint(options.endpoint, options.allowPlaintextPrivateNetwork === true);
    if (!/^sha256:[0-9a-f]{64}$/u.test(options.implementationDigest) || !/^sha256:[0-9a-f]{64}$/u.test(options.manifestHash)) {
      throw new TypeError("provider implementation and manifest hashes must be lowercase SHA-256 digests");
    }
    assertApprovedManifest(options);
  }

  async manifest(): Promise<CapabilityProviderManifest> {
    return structuredClone(this.options.approvedManifest);
  }

  async health(deadlineAt?: string): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const timeout = (): number => deadlineAt === undefined
        ? this.#controlTimeoutMs
        : Math.min(this.#controlTimeoutMs, remainingDeadlineMs(deadlineAt));
      const manifest = await this.#loadLiveManifest(timeout());
      const [liveness, readiness] = await Promise.all([
        this.#controlRequest(manifest.endpoints.liveness, timeout()),
        this.#controlRequest(manifest.endpoints.readiness, timeout())
      ]);
      return {
        live: liveness.ok,
        ready: liveness.ok && readiness.ok,
        checkedAt,
        detail: `liveness=${liveness.status};readiness=${readiness.status}`
      };
    } catch (error) {
      if (deadlineAt !== undefined && error instanceof ProviderProtocolError && error.code === "DEADLINE_EXCEEDED") {
        throw error;
      }
      return { live: false, ready: false, checkedAt, detail: "provider control plane unavailable" };
    }
  }

  async execute(operationId: string, request: ProviderExecutionRequest): Promise<CapabilityResultEnvelope> {
    const initialRemainingMs = remainingDeadlineMs(request.executionPolicy.deadlineAt);
    const manifest = await this.#loadLiveManifest(Math.min(this.#controlTimeoutMs, initialRemainingMs));
    if (!manifest.capabilities.some((descriptor) => descriptor.operationId === operationId)) {
      throw new ProviderProtocolError("OPERATION_NOT_FOUND", "operation is not declared by the controlled provider manifest");
    }
    const remainingMs = remainingDeadlineMs(request.executionPolicy.deadlineAt);
    const path = manifest.endpoints.execute.replace("{operationId}", encodeURIComponent(operationId));
    const { response, payload } = await this.#requestJson(path, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.options.transportToken}`,
        "content-type": "application/json",
        "x-request-id": request.requestId,
        "x-gowm-trace-id": request.gatewayRequestId
      },
      body: JSON.stringify(request)
    }, remainingMs);
    if (!response.ok) throw providerHttpError(response.status, payload, this.providerId);
    return payload as CapabilityResultEnvelope;
  }

  async #loadLiveManifest(timeoutMs = this.#controlTimeoutMs): Promise<CapabilityProviderManifest> {
    const { response, payload } = await this.#requestJson(
      this.options.manifestPath ?? "/v1/manifest",
      { method: "GET", headers: { accept: "application/json" } },
      timeoutMs
    );
    if (!response.ok) throw new ProviderProtocolError("PROVIDER_NOT_READY", "provider manifest endpoint is unavailable");
    const validation = validateContract("capability-provider-manifest.schema.json", payload);
    if (!validation.valid) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider manifest violates the Provider Protocol contract");
    }
    const manifest = payload as CapabilityProviderManifest;
    const semantics = validateProviderManifestSemantics(manifest);
    if (!semantics.valid) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider manifest fails semantic validation");
    }
    if (
      manifest.provider.providerId !== this.options.providerId ||
      manifest.provider.providerVersion !== this.options.providerVersion ||
      manifest.provider.implementationDigest !== this.options.implementationDigest ||
      sha256(manifest) !== this.options.manifestHash
    ) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider manifest differs from the approved deployment lock");
    }
    return structuredClone(manifest);
  }

  async #controlRequest(path: string, timeoutMs: number): Promise<Response> {
    return this.#requestStatus(path, { method: "GET", headers: { accept: "application/json" } }, timeoutMs);
  }

  async #requestJson(
    path: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<{ response: Response; payload: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await this.#fetch(controlledProviderUrl(this.options.endpoint, path), {
        ...init,
        signal: controller.signal,
        redirect: "error"
      });
      const payload = await readJson(response, this.#maximumResponseBytes, controller.signal);
      return { response, payload };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProviderProtocolError("DEADLINE_EXCEEDED", "provider HTTP request exceeded its controlled timeout", { cause: error });
      }
      if (error instanceof ProviderProtocolError) throw error;
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "provider HTTP endpoint is unavailable", {
        retryable: true,
        cause: error
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #requestStatus(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await this.#fetch(controlledProviderUrl(this.options.endpoint, path), {
        ...init,
        signal: controller.signal,
        redirect: "error"
      });
      if (response.body !== null) void response.body.cancel().catch(() => undefined);
      return response;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProviderProtocolError("DEADLINE_EXCEEDED", "provider HTTP request exceeded its controlled timeout", { cause: error });
      }
      if (error instanceof ProviderProtocolError) throw error;
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "provider HTTP endpoint is unavailable", {
        retryable: true,
        cause: error
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertApprovedManifest(options: HttpProviderClientOptions): void {
  const validation = validateContract("capability-provider-manifest.schema.json", options.approvedManifest);
  if (!validation.valid) throw new TypeError("approved provider manifest violates the Provider Protocol contract");
  if (!validateProviderManifestSemantics(options.approvedManifest).valid) {
    throw new TypeError("approved provider manifest fails semantic validation");
  }
  if (
    options.approvedManifest.provider.providerId !== options.providerId ||
    options.approvedManifest.provider.providerVersion !== options.providerVersion ||
    options.approvedManifest.provider.implementationDigest !== options.implementationDigest ||
    sha256(options.approvedManifest) !== options.manifestHash
  ) {
    throw new TypeError("approved provider manifest differs from the deployment lock");
  }
}

export function controlledProviderUrl(endpoint: URL, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider route must be a single-origin absolute path");
  }
  const resolved = new URL(path, endpoint);
  if (
    resolved.origin !== endpoint.origin ||
    resolved.username ||
    resolved.password ||
    resolved.search ||
    resolved.hash
  ) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider route escaped the approved origin");
  }
  return resolved;
}

async function readJson(response: Response, maximumBytes: number, signal: AbortSignal): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maximumBytes) {
    if (response.body !== null) void response.body.cancel().catch(() => undefined);
    throw new ProviderProtocolError("BUDGET_EXCEEDED", "provider HTTP response exceeds the transport limit");
  }
  if (!(response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ?? false)) {
    if (response.body !== null) void response.body.cancel().catch(() => undefined);
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider HTTP response is not JSON");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider HTTP response contains malformed JSON");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await readWithAbort(reader, signal);
      if (chunk.done) break;
      const value = chunk.value;
      if (value === undefined) {
        throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider HTTP response contains malformed JSON");
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ProviderProtocolError("BUDGET_EXCEEDED", "provider HTTP response exceeds the transport limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ProviderProtocolError) throw error;
    if (signal.aborted) throw error;
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider HTTP response contains malformed JSON", { cause: error });
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider HTTP response contains malformed JSON", { cause: error });
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal.aborted) {
    void reader.cancel().catch(() => undefined);
    throw signal.reason;
  }
  return new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
    const abort = (): void => {
      void reader.cancel().catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

function providerHttpError(status: number, payload: unknown, providerId: string): ProviderProtocolError {
  const upstreamError = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  const candidate = upstreamError?.code;
  const code = typeof candidate === "string" && (PROVIDER_ERROR_CODES as readonly string[]).includes(candidate)
    ? candidate as ProviderErrorCode
    : status === 408 || status === 504
      ? "DEADLINE_EXCEEDED"
      : status === 413
        ? "BUDGET_EXCEEDED"
        : status === 429
          ? "OVERLOADED"
          : status === 503
            ? "PROVIDER_NOT_READY"
            : status >= 400 && status < 500
              ? "INVALID_REQUEST"
              : "INTERNAL_PROVIDER_ERROR";
  return new ProviderProtocolError(code, `provider returned ${code}`, {
    ...(typeof upstreamError?.retryable === "boolean" ? { retryable: upstreamError.retryable } : {}),
    details: {
      upstreamStatus: status,
      providerId,
      stage: "PROVIDER_EXECUTION"
    }
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function remainingDeadlineMs(deadlineAt: string): number {
  const remainingMs = Math.floor(Date.parse(deadlineAt) - Date.now());
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new ProviderProtocolError("DEADLINE_EXCEEDED", "provider request deadline elapsed before transport execution");
  }
  return remainingMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
