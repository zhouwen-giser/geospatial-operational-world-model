import { createHash } from "node:crypto";
import { compareUnicodeCodePoints } from "../../platform/contract-runtime/src/index.js";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
        .map(([key, item]) => [key, normalize(item)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function stableKey(prefix: "nd" | "ed" | "ar" | "tr" | "ts" | "cs", value: unknown): string {
  return `${prefix}_${sha256(value).slice("sha256:".length)}`;
}
