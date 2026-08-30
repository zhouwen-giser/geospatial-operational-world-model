import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

  it("reports hashes from an isolated real v0.7.1 consumer bundle build", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const sourceLockPath = join(repositoryRoot, "contracts/consumers/wsgs-southbound-operation-lock-v2.json");
    const sourceLockBefore = await readFile(sourceLockPath);
    const executed = spawnSync(
      process.execPath,
      ["--import", "tsx", "validation/scripts/gowm-v071-canonical-order-matrix.ts", "--emit"],
      { cwd: repositoryRoot, encoding: "utf8", windowsHide: true }
    );
    if (executed.status !== 0) {
      throw new Error(`Canonical-order consumer fixture failed: ${executed.stderr}`);
    }

    const emitted = JSON.parse(executed.stdout.trim()) as {
      consumerLockHash: string;
      consumerPackageIntegrity: string;
      consumerBundleManifestHash: string;
      consumerBundleFileRecordsHash: string;
    };
    const bundleRoot = join(repositoryRoot, "packages/platform/world-gateway-contracts/bundle");
    const lockBytes = await readFile(join(bundleRoot, "locks/wsgs-southbound-operation-lock-v2.json"));
    const manifestBytes = await readFile(join(bundleRoot, "MANIFEST.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      packageIntegrity: string;
      files: Array<{ path: string; bytes: number; sha256: string }>;
    };

    expect(emitted.consumerLockHash).toBe(sha256Bytes(lockBytes));
    expect(emitted.consumerPackageIntegrity).toBe(manifest.packageIntegrity);
    expect(emitted.consumerBundleManifestHash).toBe(sha256Bytes(manifestBytes));
    expect(emitted.consumerBundleFileRecordsHash).toBe(canonicalSha256(manifest.files));
    expect(await readFile(sourceLockPath)).toEqual(sourceLockBefore);
  });
});

function sha256Bytes(value: Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
