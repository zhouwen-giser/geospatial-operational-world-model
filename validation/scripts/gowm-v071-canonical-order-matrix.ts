import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalSha256,
  canonicalSortStrings,
  catalogRevisions,
  compareCanonicalJson,
  compareUnicodeCodePoints
} from "../../packages/platform/contract-runtime/src/index.js";

const locales = ["C", "en_US.UTF-8", "zh_CN.UTF-8"] as const;

if (process.argv.includes("--emit")) {
  process.stdout.write(`${JSON.stringify(await fixtureHashes())}\n`);
} else {
  const reports = locales.map((locale) => {
    const executed = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "--emit"], {
      cwd: resolve(import.meta.dirname, "../.."),
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
  const consumerLockHash = canonicalSha256({
    packageVersion: "0.7.1",
    operations: ordered.map((value) => ({ operationId: value, operationVersion: "1.0" }))
  });
  return {
    ordered,
    snapshotManifestHash,
    contractCatalogRevision: revisions.contractCatalogRevision,
    bindingRevision: revisions.bindingRevision,
    semanticEvidenceDigest,
    consumerLockHash
  };
}
