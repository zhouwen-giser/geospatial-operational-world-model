import { randomUUID } from "node:crypto";
import {
  canonicalJson as contractCanonicalJson,
  canonicalSha256
} from "../../contract-runtime/src/index.js";

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const validate = (current: unknown): void => {
    if (current === null) return;
    if (typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("canonical JSON rejects non-finite numbers");
      return;
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current)) throw new TypeError("canonical JSON rejects cyclic values");
      ancestors.add(current);
      for (const entry of current) {
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
          throw new TypeError("canonical JSON rejects non-JSON array values");
        }
        validate(entry);
      }
      ancestors.delete(current);
      return;
    }
    if (typeof current === "object") {
      if (ancestors.has(current)) throw new TypeError("canonical JSON rejects cyclic values");
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("canonical JSON accepts only plain objects");
      }
      ancestors.add(current);
      for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
          throw new TypeError(`canonical JSON rejects non-JSON property ${key}`);
        }
        validate(entry);
      }
      ancestors.delete(current);
      return;
    }
    throw new TypeError(`canonical JSON rejects ${typeof current}`);
  };
  validate(value);
  return contractCanonicalJson(value);
}

export function sha256(value: unknown): `sha256:${string}` {
  canonicalJson(value);
  return canonicalSha256(value);
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

export function newOpaqueId(prefix: string): string {
  const normalizedPrefix = prefix.replaceAll("-", "_");
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(normalizedPrefix)) throw new TypeError("invalid opaque id prefix");
  return `${normalizedPrefix}_${randomUUID().replaceAll("-", "")}`;
}
