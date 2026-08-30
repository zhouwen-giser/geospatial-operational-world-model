import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertPostMergeMainCi } from "./gowm-v071-ci-authority.mjs";
import {
  assertValidHistoricalConsumerLock,
  readHistoricalConsumerBindingAuthority,
  readVerifiedQualificationReport,
} from "./gowm-v071-evidence-verification.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const authority = assertPostMergeMainCi();
const commit = git(["rev-parse", "HEAD"]);
const tree = git(["rev-parse", "HEAD^{tree}"]);
const evidenceRoot = resolve(process.env.GOWM_V071_EVIDENCE_ROOT ?? resolve(root, "output", "gowm-v0.7.1", commit));
if (authority.commit !== commit) {
  throw new Error("checked-out source differs from GITHUB_SHA");
}
if (git(["status", "--porcelain=v1", "--untracked-files=all"]).length !== 0) {
  throw new Error("WSGS lock generation requires a clean worktree, including staged and untracked files");
}

const prerequisiteIds = [
  "source-lock",
  "protocol-closure-report",
  "deterministic-hash-report",
  "database-fresh-report",
  "database-upgrade-report",
  "gateway-runtime-report",
  "node-adherence-report",
  "worker-backoff-report",
  "artifact-roundtrip-report",
  "historical-two-provider-dag-report"
];
const evidenceFiles = [];
for (const reportId of prerequisiteIds) {
  const acceptedStatuses = reportId === "artifact-roundtrip-report" ? ["DEFERRED"] : ["PASS"];
  const { bytes } = await readVerifiedQualificationReport({
    evidenceRoot,
    reportId,
    commit,
    tree,
    ciSource: authority.ciSource,
    acceptedStatuses
  });
  evidenceFiles.push({ reportId, sha256: createHash("sha256").update(bytes).digest("hex") });
}

const bindingAuthority = await readHistoricalConsumerBindingAuthority(root);
const { consumerLock, operations, providerManifests, bindingRevision } = bindingAuthority;
const runtimeQualificationEvidenceDigest = `sha256:${createHash("sha256")
  .update(JSON.stringify(evidenceFiles.sort((left, right) => left.reportId < right.reportId ? -1 : left.reportId > right.reportId ? 1 : 0)))
  .digest("hex")}`;
const lock = {
  schemaVersion: "1.0",
  candidateCommit: commit,
  candidateTree: tree,
  ciSource: authority.ciSource,
  bindingRevision,
  consumerContractPackage: {
    name: consumerLock.consumerContractPackage.name,
    version: consumerLock.consumerContractPackage.version,
    integrity: consumerLock.consumerContractPackage.integrity,
    contractCatalogRevision: consumerLock.contractCatalogRevision,
    semanticCatalogHash: consumerLock.semanticCatalogHash
  },
  providerManifests,
  operations,
  snapshotBehavior: {
    scopeModel: consumerLock.scopeModel,
    resourceIdEncodingRevision: consumerLock.resourceIdEncodingRevision,
    canonicalOrderingRevision: consumerLock.canonicalOrderingRevision
  },
  migrationHead: "068_effective_snapshot_consistency_downgrade.sql",
  runtimeQualificationEvidenceDigest,
  allowedConsumerCapabilities: [
    "TASK_EXECUTION_INTERVAL",
    "HISTORICAL_TRAJECTORY",
    "GAP",
    "COMPLETENESS",
    "CURRENTNESS_REPLAY_FOUNDATION"
  ],
  explicitNonClaims: [
    "MAP_MATCHING",
    "TEMPORAL_SPATIAL_EVENTS",
    "LAST_INTERSECTION",
    "HISTORICAL_SIGNAL_RANKING",
    "COMPLETE_TRAJECTORY_ARTIFACT"
  ],
  marker: "GOWM_V071_WSGS_HISTORICAL_BASELINE_READY"
};
assertValidHistoricalConsumerLock(lock, {
  ciSource: authority.ciSource,
  bindingRevision,
  operations,
  providerManifests
});
await mkdir(evidenceRoot, { recursive: true });
const lockBytes = `${JSON.stringify(lock, null, 2)}\n`;
await writeFile(resolve(evidenceRoot, "GOWM_HISTORICAL_CONSUMER_LOCK.json"), lockBytes, "utf8");
const report = {
  schemaVersion: "1.0",
  candidateCommit: commit,
  candidateTree: tree,
  generatedAt: new Date().toISOString(),
  evidenceAuthority: "IMMUTABLE_CI_ARTIFACT",
  ciSource: authority.ciSource,
  reportId: "wsgs-historical-consumer-lock",
  status: "PASS",
  gate: "WSGS Historical Consumer Baseline",
  marker: lock.marker,
  reason: `GOWM_HISTORICAL_CONSUMER_LOCK.json sha256:${createHash("sha256").update(lockBytes).digest("hex")}`,
  lock: {
    relativePath: "GOWM_HISTORICAL_CONSUMER_LOCK.json",
    bytes: Buffer.byteLength(lockBytes),
    sha256: `sha256:${createHash("sha256").update(lockBytes).digest("hex")}`
  }
};
await writeFile(resolve(evidenceRoot, "wsgs-historical-consumer-lock.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);

function git(arguments_) {
  const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("unable to resolve exact source identity");
  return result.stdout.trim().toLowerCase();
}
