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

export const EXACT_HEAD_RUNTIME_REPORT_ID = "exact-head-runtime-report";
export const EXACT_HEAD_RUNTIME_MARKER = "GOWM_V071_EXACT_HEAD_RUNTIME_QUALIFIED";
export const GATEWAY_SCENARIO_REPORT_REQUIREMENTS = Object.freeze({
  "snapshot-downgrade-resource-retention-report": Object.freeze([
    "case2DowngradedProviderResourceRetained",
    "case2DowngradedResourceNotFalselyPinned",
    "case2DowngradeChangesEffectiveSnapshotHash"
  ]),
  "historical-event-set-advancement-report": Object.freeze([
    "pendingIntervalInputSetRemainsD1",
    "pendingCurrentEventSetAdvancesToD2",
    "pendingEventSetDigestsDiffer",
    "pendingEventSetAdvancesEffectiveSnapshotHash",
    "rebuiltIntervalInputMatchesCurrentEventSet"
  ])
});
export const EXACT_HEAD_RUNTIME_PREREQUISITES = [
  { reportId: "source-lock", acceptedStatuses: ["PASS"] },
  { reportId: "protocol-closure-report", acceptedStatuses: ["PASS"] },
  { reportId: "deterministic-hash-report", acceptedStatuses: ["PASS"] },
  { reportId: "database-fresh-report", acceptedStatuses: ["PASS"] },
  { reportId: "database-upgrade-report", acceptedStatuses: ["PASS"] },
  { reportId: "gateway-runtime-report", acceptedStatuses: ["PASS"] },
  { reportId: "snapshot-downgrade-resource-retention-report", acceptedStatuses: ["PASS"] },
  { reportId: "historical-event-set-advancement-report", acceptedStatuses: ["PASS"] },
  { reportId: "node-adherence-report", acceptedStatuses: ["PASS"] },
  { reportId: "worker-backoff-report", acceptedStatuses: ["PASS"] },
  { reportId: "artifact-roundtrip-report", acceptedStatuses: ["DEFERRED"] },
  { reportId: "historical-two-provider-dag-report", acceptedStatuses: ["PASS"] }
];

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
    assertGatewayScenarioReport(report, logBytes);
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

export function gatewayScenarioChecks(reportId, logBytes) {
  const requiredChecks = GATEWAY_SCENARIO_REPORT_REQUIREMENTS[reportId];
  if (requiredChecks === undefined) return undefined;
  const summary = lastGatewayQualificationSummary(logBytes);
  if (summary.status !== "PASS" || summary.gate !== "GOWM_V07_HISTORY_GATEWAY_E2E") {
    throw new Error(`${reportId} immutable log does not end in a passing Gateway qualification summary`);
  }
  const checks = summary.checks;
  if (checks === null || typeof checks !== "object" || Array.isArray(checks)) {
    throw new Error(`${reportId} Gateway qualification summary does not expose scenario checks`);
  }
  const scenarioChecks = {};
  for (const check of requiredChecks) {
    if (checks[check] !== true) {
      throw new Error(`${reportId} Gateway qualification check ${check} is not true`);
    }
    scenarioChecks[check] = true;
  }
  return scenarioChecks;
}

function assertGatewayScenarioReport(report, logBytes) {
  const expected = gatewayScenarioChecks(report.reportId, logBytes);
  if (expected !== undefined && canonicalJson(report.scenarioChecks) !== canonicalJson(expected)) {
    throw new Error(`${report.reportId} scenarioChecks do not bind the required Gateway qualification checks`);
  }
}

function lastGatewayQualificationSummary(logBytes) {
  const lines = Buffer.from(logBytes).toString("utf8").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  try {
    const candidate = JSON.parse(lines.at(-1) ?? "");
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      && candidate.gate === "GOWM_V07_HISTORY_GATEWAY_E2E") {
      return candidate;
    }
  } catch {
    // Only the final complete JSON summary is authoritative; diagnostics cannot satisfy a scenario gate.
  }
  throw new Error("immutable log does not end in a Gateway qualification JSON summary");
}

export async function readVerifiedExactHeadRuntimeQualification({
  evidenceRoot,
  commit,
  tree,
  ciSource
}) {
  const prerequisiteChecks = [];
  for (const { reportId, acceptedStatuses } of EXACT_HEAD_RUNTIME_PREREQUISITES) {
    const { report, bytes } = await readVerifiedQualificationReport({
      evidenceRoot,
      reportId,
      commit,
      tree,
      ciSource,
      acceptedStatuses
    });
    prerequisiteChecks.push({
      reportId,
      status: report.status,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    });
  }
  const verified = await readVerifiedQualificationReport({
    evidenceRoot,
    reportId: EXACT_HEAD_RUNTIME_REPORT_ID,
    commit,
    tree,
    ciSource,
    acceptedStatuses: ["PASS"]
  });
  if (verified.report.marker !== EXACT_HEAD_RUNTIME_MARKER) {
    throw new Error("exact-head runtime qualification marker drifted");
  }
  if (!sameRecordSet(verified.report.checks, prerequisiteChecks, "reportId")) {
    throw new Error("exact-head runtime qualification checks do not bind the prerequisite report bytes");
  }
  return { ...verified, prerequisiteChecks };
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
  if (expected.commit !== undefined && lock.candidateCommit !== expected.commit) {
    throw new Error("WSGS Historical Consumer Lock candidateCommit drifted");
  }
  if (expected.tree !== undefined && lock.candidateTree !== expected.tree) {
    throw new Error("WSGS Historical Consumer Lock candidateTree drifted");
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
