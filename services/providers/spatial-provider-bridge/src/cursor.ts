import { createHmac, timingSafeEqual } from "node:crypto";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { SpatialOperationId } from "./schemas.js";

export interface SpatialCursorPayload {
  v: 1;
  operationId: SpatialOperationId;
  scopeDigest: `sha256:${string}`;
  snapshotVersion: string;
  sort: "id" | "distance";
  id: string;
  distanceM?: number;
}

export function dataScopeDigest(dataScopeKey: string, datasetScopeKey?: string): `sha256:${string}` {
  return sha256({ dataScopeKey, ...(datasetScopeKey === undefined ? {} : { datasetScopeKey }) });
}

export function encodeSpatialCursor(payload: SpatialCursorPayload, secret: string): string {
  assertSecret(secret);
  validatePayload(payload);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
}

export function decodeSpatialCursor(
  value: string | undefined,
  expected: Pick<SpatialCursorPayload, "operationId" | "scopeDigest" | "snapshotVersion" | "sort">,
  secret: string
): SpatialCursorPayload | undefined {
  assertSecret(secret);
  if (value === undefined) return undefined;
  const [encoded, suppliedSignature, extra] = value.split(".");
  if (!encoded || !suppliedSignature || extra !== undefined) throw invalidCursor();
  const expectedSignature = signature(encoded, secret);
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const calculated = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== calculated.length || !timingSafeEqual(supplied, calculated)) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw invalidCursor();
  }
  if (!isCursorPayload(parsed)) throw invalidCursor();
  validatePayload(parsed);
  if (
    parsed.operationId !== expected.operationId ||
    parsed.scopeDigest !== expected.scopeDigest ||
    parsed.snapshotVersion !== expected.snapshotVersion ||
    parsed.sort !== expected.sort
  ) {
    throw new ProviderProtocolError("INVALID_REQUEST", "cursor is unavailable for this operation, scope, or current snapshot", {
      retryable: false
    });
  }
  return parsed;
}

function signature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("spatial cursor secret must contain at least 32 bytes");
}

function validatePayload(payload: SpatialCursorPayload): void {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u.test(payload.id)) throw invalidCursor();
  if (!payload.snapshotVersion || payload.snapshotVersion.length > 128) throw invalidCursor();
  if (payload.sort === "distance" && (payload.distanceM === undefined || !Number.isFinite(payload.distanceM) || payload.distanceM < 0)) {
    throw invalidCursor();
  }
  if (payload.sort === "id" && payload.distanceM !== undefined) throw invalidCursor();
}

function isCursorPayload(value: unknown): value is SpatialCursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1 &&
    typeof candidate.operationId === "string" &&
    typeof candidate.scopeDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(candidate.scopeDigest) &&
    typeof candidate.snapshotVersion === "string" &&
    (candidate.sort === "id" || candidate.sort === "distance") &&
    typeof candidate.id === "string" &&
    (candidate.distanceM === undefined || typeof candidate.distanceM === "number");
}

function invalidCursor(): ProviderProtocolError {
  return new ProviderProtocolError("INVALID_REQUEST", "cursor is invalid", { retryable: false });
}
