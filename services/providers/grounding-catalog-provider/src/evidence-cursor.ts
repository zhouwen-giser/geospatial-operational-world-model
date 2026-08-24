import { createHmac, timingSafeEqual } from "node:crypto";
import { ProviderProtocolError } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { GroundingCatalogOperationId } from "./schemas.js";

export interface EvidenceCursor {
  v: 1;
  operationId: GroundingCatalogOperationId;
  scopeDigest: `sha256:${string}`;
  snapshotVersion: string;
  time: string;
  tie: string;
  id: string;
}

export function encodeEvidenceCursor(payload: EvidenceCursor, secret: string): string {
  assertSecret(secret);
  validate(payload);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

export function decodeEvidenceCursor(
  value: string | undefined,
  expected: Pick<EvidenceCursor, "operationId" | "scopeDigest" | "snapshotVersion">,
  secret: string
): EvidenceCursor | undefined {
  assertSecret(secret);
  if (value === undefined) return undefined;
  const [encoded, suppliedSignature, extra] = value.split(".");
  if (!encoded || !suppliedSignature || extra !== undefined) throw invalid();
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const calculated = Buffer.from(createHmac("sha256", secret).update(encoded).digest("base64url"), "utf8");
  if (supplied.length !== calculated.length || !timingSafeEqual(supplied, calculated)) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw invalid(); }
  if (!isCursor(parsed)) throw invalid();
  validate(parsed);
  if (parsed.operationId !== expected.operationId || parsed.scopeDigest !== expected.scopeDigest || parsed.snapshotVersion !== expected.snapshotVersion) {
    throw new ProviderProtocolError("INVALID_REQUEST", "evidence cursor is unavailable for this operation, scope, or snapshot");
  }
  return parsed;
}

function validate(value: EvidenceCursor): void {
  if (!Number.isFinite(Date.parse(value.time)) || value.tie.length < 1 || value.tie.length > 256 || value.id.length < 1 || value.id.length > 256) throw invalid();
  if (value.operationId === "world.get-event-timeline") {
    if (!/^(0|[1-9][0-9]*)$/u.test(value.tie)) throw invalid();
  } else if (!Number.isFinite(Date.parse(value.tie))) {
    throw invalid();
  }
}
function isCursor(value: unknown): value is EvidenceCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1 && typeof candidate.operationId === "string" &&
    typeof candidate.scopeDigest === "string" && /^sha256:[0-9a-f]{64}$/u.test(candidate.scopeDigest) &&
    typeof candidate.snapshotVersion === "string" && typeof candidate.time === "string" &&
    typeof candidate.tie === "string" && typeof candidate.id === "string";
}
function assertSecret(secret: string): void { if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("evidence cursor secret must contain at least 32 bytes"); }
function invalid(): ProviderProtocolError { return new ProviderProtocolError("INVALID_REQUEST", "evidence cursor is invalid"); }
