import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

/** Locale-independent Unicode code-unit order for hash-critical collections. */
export function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function stableKey(prefix: string, value: unknown): string {
  return `${prefix}_${sha256(canonicalJson(value)).slice("sha256:".length)}`;
}

export function stableReferenceKey(value: unknown): string { return `wrf_${sha256(canonicalJson(value)).slice("sha256:".length, "sha256:".length + 32)}`; }

export function prettyCanonical(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}
