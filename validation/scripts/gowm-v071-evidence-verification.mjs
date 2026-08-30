import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalSha256,
  catalogRevisions,
  compareUnicodeCodePoints,
  validateContract
} from "../../packages/platform/contract-runtime/src/index.ts";

const HISTORICAL_OPERATION_BINDINGS = [
  { operationId: "history.get-trajectory", providerId: "gowm.historical-trace" },
  { operationId: "operational-task.get-execution-intervals", providerId: "gowm.operational-reality" }
];

const HISTORICAL_PROVIDER_IDS = HISTORICAL_OPERATION_BINDINGS.map(({ providerId }) => providerId);

export async function readVerifiedQualificationReport({
  evidenceRoot,
  reportId,
  commit,
  tree,
  ciSource,
  acceptedStatuses
}) {
  if (ciSource === undefined) {
    throw new Error(`${reportId} verification requires exact CI source identity`);
  }
  const path = resolve(evidenceRoot, `${reportId}.json`);
  const bytes = await readFile(path);
  const report = JSON.parse(bytes.toString("utf8"));
  const validation = validateContract("urn:gowm:v0.7.1:exact-head-qualification-report", report);
  if (!validation.valid) {
    throw new Error(`${reportId} violates the qualification report schema: ${JSON.stringify(validation.issues)}`);
  }
  if (
    report.reportId !== reportId
    || report.candidateCommit !== commit
    || report.candidateTree !== tree
    || !sameCiSource(report.ciSource, ciSource)
    || !acceptedStatuses.includes(report.status)
  ) {
    throw new Error(`${reportId} is not accepted exact-source evidence`);
  }
  if (report.log !== undefined) {
    const expectedRelativePath = `logs/${reportId}.log`;
    if (report.log.relativePath !== expectedRelativePath) {
      throw new Error(`${reportId} log path is not bound to its report id`);
    }
    const logBytes = await readFile(resolve(evidenceRoot, expectedRelativePath));
    const digest = `sha256:${createHash("sha256").update(logBytes).digest("hex")}`;
    if (report.log.bytes !== logBytes.length || report.log.sha256 !== digest) {
      throw new Error(`${reportId} log bytes or digest differ from the report`);
    }
  }
  if (report.command !== undefined) {
    if (report.exitCode !== 0 || report.log === undefined || report.trackedWorktreeCleanAfter !== true) {
      throw new Error(`${reportId} command evidence is not a clean successful execution`);
    }
  }
  if (reportId === "source-lock" && report.trackedWorktreeCleanAtStart !== true) {
    throw new Error("source-lock did not attest a clean worktree");
  }
  return { report, bytes };
}

export function selectHistoricalConsumerOperations(consumerLock) {
  if (!Array.isArray(consumerLock?.defaultOperations) || !Array.isArray(consumerLock?.previewOperations)) {
    throw new Error("consumer lock does not expose default and preview operation collections");
  }
  const published = [...consumerLock.defaultOperations, ...consumerLock.previewOperations];
  return HISTORICAL_OPERATION_BINDINGS.map(({ operationId, providerId }) => {
    const matches = published.filter((operation) => operation?.operationId === operationId);
    if (matches.length !== 1) {
      throw new Error(`consumer lock must publish exactly one ${operationId}; found ${matches.length}`);
    }
    const operation = matches[0];
    if (operation.maturity !== "PREVIEW") {
      throw new Error(`consumer lock ${operationId} maturity drifted from PREVIEW`);
    }
    return {
      operationId,
      providerId,
      operationVersion: operation.operationVersion,
      inputSchemaHash: operation.inputSchemaHash,
      outputSchemaHash: operation.outputSchemaHash,
      semanticProfileHash: operation.semanticProfileHash,
      maturity: operation.maturity
    };
  });
}

export function selectHistoricalConsumerProviderManifests(registry) {
  if (!Array.isArray(registry?.providers)) {
    throw new Error("world-platform registry does not expose Provider bindings");
  }
  return HISTORICAL_PROVIDER_IDS.map((providerId) => {
    const matches = registry.providers.filter((provider) => provider?.providerId === providerId);
    if (matches.length !== 1) {
      throw new Error(`world-platform registry must bind exactly one ${providerId}; found ${matches.length}`);
    }
    const provider = matches[0];
    return {
      providerId,
      providerVersion: provider.providerVersion,
      implementationDigest: provider.implementationDigest,
      manifestHash: provider.manifestHash
    };
  });
}

export async function readHistoricalConsumerBindingAuthority(repositoryRoot) {
  const consumerLock = JSON.parse(await readFile(
    resolve(repositoryRoot, "contracts/consumers/wsgs-southbound-operation-lock-v2.json"),
    "utf8"
  ));
  const registry = JSON.parse(await readFile(
    resolve(repositoryRoot, "config/world-platform-gateway-registry.json"),
    "utf8"
  ));
  const operations = selectHistoricalConsumerOperations(consumerLock);
  const providerManifests = selectHistoricalConsumerProviderManifests(registry);
  const revisionBindings = await Promise.all(registry.providers.map(async (provider) => {
    if (typeof provider?.manifestPath !== "string" || typeof provider?.approvalId !== "string") {
      throw new Error("world-platform registry Provider binding is incomplete");
    }
    const manifest = JSON.parse(await readFile(resolve(repositoryRoot, provider.manifestPath), "utf8"));
    if (
      manifest?.provider?.providerId !== provider.providerId
      || manifest?.provider?.providerVersion !== provider.providerVersion
      || manifest?.provider?.implementationDigest !== provider.implementationDigest
      || canonicalSha256(manifest) !== provider.manifestHash
    ) {
      throw new Error(`world-platform registry Provider binding drifted for ${provider.providerId}`);
    }
    return { manifest, approvalId: provider.approvalId };
  }));
  const revisions = catalogRevisions(revisionBindings);
  if (revisions.contractCatalogRevision !== consumerLock.contractCatalogRevision) {
    throw new Error("consumer lock contractCatalogRevision differs from the authoritative world-platform Registry");
  }
  return {
    consumerLock,
    operations,
    providerManifests,
    bindingRevision: revisions.bindingRevision
  };
}

export function assertValidHistoricalConsumerLock(lock, expected = {}) {
  const validation = validateContract("urn:gowm:v0.7.1:wsgs-historical-consumer-lock", lock);
  if (!validation.valid) {
    throw new Error(`WSGS Historical Consumer Lock violates its contract: ${JSON.stringify(validation.issues)}`);
  }
  if (expected.ciSource !== undefined && !sameCiSource(lock.ciSource, expected.ciSource)) {
    throw new Error("WSGS Historical Consumer Lock CI source identity drifted");
  }
  if (expected.bindingRevision !== undefined && lock.bindingRevision !== expected.bindingRevision) {
    throw new Error("WSGS Historical Consumer Lock bindingRevision drifted");
  }
  if (expected.operations !== undefined && !sameRecordSet(lock.operations, expected.operations, "operationId")) {
    throw new Error("WSGS Historical Consumer Lock operation bindings drifted");
  }
  if (
    expected.providerManifests !== undefined
    && !sameRecordSet(lock.providerManifests, expected.providerManifests, "providerId")
  ) {
    throw new Error("WSGS Historical Consumer Lock Provider manifest bindings drifted");
  }
}

function sameCiSource(left, right) {
  return left?.githubRepository === right?.githubRepository
    && left?.githubWorkflowRef === right?.githubWorkflowRef
    && left?.githubRunId === right?.githubRunId
    && left?.githubRunAttempt === right?.githubRunAttempt;
}

function sameRecordSet(left, right, identityField) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const ordered = (records) => [...records].sort((a, b) =>
    compareUnicodeCodePoints(String(a?.[identityField] ?? ""), String(b?.[identityField] ?? ""))
  );
  return canonicalJson(ordered(left)) === canonicalJson(ordered(right));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => compareUnicodeCodePoints(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
