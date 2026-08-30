import { createHash } from "node:crypto";
import type { Sha256Digest } from "../../historical-trace-model/src/interval.js";
import { logicalReferenceKey } from "../../historical-trace-model/src/references.js";
import type {
  HistoricalSemanticRequest,
  HistoricalSemanticRequestIdentity,
  HistoricalSourceSelection
} from "../../historical-trace-model/src/trajectory.js";

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
  return Object.is(value, -0) ? "0" : JSON.stringify(value);
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value !== "object") throw new TypeError(`Canonical JSON does not support ${typeof value}`);

  const object = value as object;
  if (ancestors.has(object)) throw new TypeError("Canonical JSON does not support cyclic values");
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError("Canonical JSON does not support sparse arrays");
        encoded.push(encode(value[index], ancestors));
      }
      return `[${encoded.join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(object);
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

export function canonicalSha256(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

/** Hashes an exact multiset independently of caller iteration order. */
export function canonicalInputSetHash(inputs: readonly unknown[]): Sha256Digest {
  const members = inputs.map((input) => canonicalJson(input)).sort();
  return canonicalSha256(members);
}

function canonicalSourceSelection(selection: HistoricalSourceSelection): HistoricalSourceSelection {
  if (selection.mode === "ONLY_CANDIDATE") return { mode: "ONLY_CANDIDATE" };
  const canonical: HistoricalSourceSelection = {
    mode: "EXPLICIT_SOURCE",
    sourceKey: selection.sourceKey
  };
  if (selection.trackerSessionKey !== undefined) canonical.trackerSessionKey = selection.trackerSessionKey;
  return canonical;
}

/**
 * Materializes the frozen logical-identity payload shared by the Provider and
 * worker. Subject, interval, and analysis-space version pins are deliberately
 * removed; the method-profile reference remains exact because its version is
 * part of the method semantics. Presentation controls are never copied here.
 */
export function historicalSemanticRequestIdentity(
  request: HistoricalSemanticRequest
): HistoricalSemanticRequestIdentity {
  const identity: HistoricalSemanticRequestIdentity = {
    subjectReferenceKey: logicalReferenceKey(request.subjectReferenceKey),
    executionIntervalReferenceKey: logicalReferenceKey(request.executionIntervalReferenceKey),
    phaseScope: request.phaseScope,
    sourceSelection: canonicalSourceSelection(request.sourceSelection),
    sourceSelectionProfileReferenceKey: {
      namespace: request.sourceSelectionProfileReferenceKey.namespace,
      kind: request.sourceSelectionProfileReferenceKey.kind,
      id: request.sourceSelectionProfileReferenceKey.id,
      version: request.sourceSelectionProfileReferenceKey.version
    }
  };
  if (request.analysisSpaceReferenceKey !== undefined) {
    identity.analysisSpaceReferenceKey = logicalReferenceKey(request.analysisSpaceReferenceKey);
  }
  return identity;
}

/** Canonical SHA-256 of the historical request's logical semantic identity. */
export function historicalSemanticRequestHash(request: HistoricalSemanticRequest): Sha256Digest {
  return canonicalSha256(historicalSemanticRequestIdentity(request));
}
