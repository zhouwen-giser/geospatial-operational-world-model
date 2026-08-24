import {
  canonicalJson as platformCanonicalJson,
  canonicalSha256
} from "../../contract-runtime/src/index.js";
import { FoundationPortError } from "./errors.js";

export function canonicalJson(value: unknown): string {
  assertJsonValue(value, new Set<object>(), "$");
  return platformCanonicalJson(value);
}

export function sha256(value: unknown): `sha256:${string}` {
  assertJsonValue(value, new Set<object>(), "$");
  return canonicalSha256(value);
}

function assertJsonValue(value: unknown, parents: Set<object>, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw receiptError(`Non-finite number at ${path}`);
    return;
  }
  if (typeof value !== "object") throw receiptError(`Unsupported value at ${path}: ${typeof value}`);
  if (parents.has(value)) throw receiptError(`Cyclic value at ${path}`);
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw receiptError(`Non-JSON object at ${path}`);
    }
  }
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertJsonValue(item, parents, `${path}[${index}]`));
      return;
    }
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw receiptError(`Undefined value at ${path}.${key}`);
      assertJsonValue(item, parents, `${path}.${key}`);
    }
  } finally {
    parents.delete(value);
  }
}

function receiptError(message: string): FoundationPortError {
  return new FoundationPortError("FOUNDATION_RECEIPT_FAILURE", message, {
    stage: "RESULT_ASSEMBLY",
    retryable: false
  });
}
