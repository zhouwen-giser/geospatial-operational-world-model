import { describe, expect, it } from "vitest";
import {
  canonicalJson as contractCanonicalJson,
  canonicalSha256
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  canonicalJson as sdkCanonicalJson,
  sha256
} from "../../packages/platform/provider-sdk/src/index.js";

describe("platform canonical JSON authority", () => {
  it("uses identical deterministic key ordering for non-ASCII operation values", () => {
    const value = { "ä": 1, z: 2, A: 3, "😀": 4 };

    expect(sdkCanonicalJson(value)).toBe(contractCanonicalJson(value));
    expect(sha256(value)).toBe(canonicalSha256(value));
    expect(sdkCanonicalJson(value)).toBe('{"A":3,"z":2,"ä":1,"😀":4}');
  });

  it("retains SDK rejection of values outside canonical JSON", () => {
    expect(() => sdkCanonicalJson({ invalid: Number.NaN })).toThrow("non-finite");
    expect(() => sdkCanonicalJson({ invalid: undefined })).toThrow("non-JSON property");
  });
});
