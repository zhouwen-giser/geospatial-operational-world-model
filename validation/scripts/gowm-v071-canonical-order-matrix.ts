import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalSha256,
  canonicalSortStrings,
  catalogRevisions,
  compareCanonicalJson,
  compareUnicodeCodePoints
} from "../../packages/platform/contract-runtime/src/index.js";

const locales = ["C", "en_US.UTF-8", "zh_CN.UTF-8"] as const;
const repositoryRoot = resolve(import.meta.dirname, "../..");
const sourceLockPath = resolve(repositoryRoot, "contracts/consumers/wsgs-southbound-operation-lock-v2.json");
const bundledLockPath = "locks/wsgs-southbound-operation-lock-v2.json";

interface ConsumerBundleManifest {
  packageIntegrity: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

interface ConsumerLock {
  consumerContractPackage: { integrity: string };
}

interface ConsumerBuildModule {
  buildConsumerContracts(
    destination: string,
    options: { writeSourceLock: false }
  ): Promise<{ packageIntegrity: string }>;
}

if (process.argv.includes("--emit")) {
  process.stdout.write(`${JSON.stringify(await fixtureHashes())}\n`);
} else {
  const reports = locales.map((locale) => {
    const executed = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "--emit"], {
      cwd: repositoryRoot,
      env: { ...process.env, LANG: locale, LC_ALL: locale },
      encoding: "utf8"
    });
    if (executed.status !== 0) throw new Error(`${locale} fixture failed: ${executed.stderr}`);
    return { locale, hashes: JSON.parse(executed.stdout.trim()) as Awaited<ReturnType<typeof fixtureHashes>> };
  });
  const expected = JSON.stringify(reports[0]!.hashes);
  if (reports.some((report) => JSON.stringify(report.hashes) !== expected)) {
    throw new Error(`canonical ordering differs across locale matrix: ${JSON.stringify(reports)}`);
  }
  process.stdout.write(`${JSON.stringify({ status: "PASS", locales, hashes: reports[0]!.hashes })}\n`);
}

async function fixtureHashes() {
  const values = JSON.parse(await readFile(resolve(import.meta.dirname, "../fixtures/canonical-order/unicode-values.json"), "utf8")) as string[];
  const ordered = canonicalSortStrings(values);
  const resources = ordered.map((value, index) => ({
    resourceKind: "FIXTURE",
    resourceId: `fixture:${value}`,
    version: String(index),
    pinning: "PINNED"
  })).sort((left, right) => compareUnicodeCodePoints(`${left.resourceKind}\u0000${left.resourceId}`, `${right.resourceKind}\u0000${right.resourceId}`));
  const snapshotManifestHash = canonicalSha256({
    querySnapshotId: "snapshot-locale-fixture",
    mode: "PINNED",
    consistency: "PINNED",
    capturedAt: "2026-08-30T00:00:00.000Z",
    resources
  });
  const bindings = ordered.map((value, index) => ({
    approvalId: `approval:${value}`,
    manifest: {
      provider: { providerId: `fixture.${index}.${value}`, providerVersion: "0.7.1", implementationDigest: canonicalSha256(value) },
      capabilities: [{ operationId: `fixture.operation-${index}`, operationVersion: "1.0", marker: value }]
    }
  }));
  const revisions = catalogRevisions(bindings as never[]);
  const evidence = values.map((value, index) => ({ value, index })).sort(compareCanonicalJson);
  const semanticEvidenceDigest = canonicalSha256(evidence);
  const consumerBundle = await consumerBundleHashes();
  return {
    ordered,
    snapshotManifestHash,
    contractCatalogRevision: revisions.contractCatalogRevision,
    bindingRevision: revisions.bindingRevision,
    semanticEvidenceDigest,
    ...consumerBundle
  };
}

async function consumerBundleHashes() {
  const initialSourceLock = await readFile(sourceLockPath);
  const outputRoot = await mkdtemp(join(tmpdir(), "gowm-v071-canonical-order-"));
  try {
    const buildModuleUrl = new URL("../../packages/platform/world-gateway-contracts/scripts/build.mjs", import.meta.url);
    const { buildConsumerContracts } = await import(buildModuleUrl.href) as ConsumerBuildModule;
    const build = await buildConsumerContracts(outputRoot, { writeSourceLock: false });
    const lockBytes = await readFile(join(outputRoot, bundledLockPath));
    const manifestBytes = await readFile(join(outputRoot, "MANIFEST.json"));
    const lock = JSON.parse(lockBytes.toString("utf8")) as ConsumerLock;
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as ConsumerBundleManifest;
    const consumerLockHash = sha256Bytes(lockBytes);
    const lockRecord = manifest.files.find((record) => record.path === bundledLockPath);

    if (lockRecord?.sha256 !== consumerLockHash.slice("sha256:".length)) {
      throw new Error("Generated consumer manifest does not hash the generated v0.7.1 lock bytes");
    }
    if (manifest.packageIntegrity !== build.packageIntegrity || lock.consumerContractPackage.integrity !== manifest.packageIntegrity) {
      throw new Error("Generated consumer lock, manifest, and build result disagree on package integrity");
    }

    return {
      consumerLockHash,
      consumerPackageIntegrity: manifest.packageIntegrity,
      consumerBundleManifestHash: sha256Bytes(manifestBytes),
      consumerBundleFileRecordsHash: canonicalSha256(manifest.files)
    };
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    const finalSourceLock = await readFile(sourceLockPath);
    if (!initialSourceLock.equals(finalSourceLock)) {
      throw new Error("Canonical-order consumer build modified the tracked source lock");
    }
  }
}

function sha256Bytes(value: Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
