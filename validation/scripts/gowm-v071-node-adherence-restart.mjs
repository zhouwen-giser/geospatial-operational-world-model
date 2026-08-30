import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vitest = fileURLToPath(new URL("../vitest.mjs", import.meta.resolve("vitest")));
const databaseUrl = process.env.GOWM_V07_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("GOWM_V07_DATABASE_URL or DATABASE_URL is required for the PostgreSQL restart gate");
}

const runId = (process.env.GOWM_V07_RUN_ID ?? `${process.env.GITHUB_RUN_ID ?? "local"}-${randomUUID()}`)
  .replaceAll("-", "")
  .slice(0, 20);
const common = {
  ...process.env,
  RUN_GOWM_V07_DB_INTEGRATION: "1",
  GOWM_V07_RUN_ID: runId
};

const before = run(
  "before",
  "GOWM_V071_NODE_ADHERENCE_RESTART_BEFORE_ASSERTED"
);
const after = run(
  "after",
  "GOWM_V071_NODE_ADHERENCE_RESTART_AFTER_ASSERTED"
);

assertEqual(before.runId, runId, "phase A run id");
assertEqual(after.runId, runId, "phase B run id");
assertEqual(after.queryId, before.queryId, "persisted query id");
assertEqual(after.jobId, before.jobId, "persisted job id");
assertEqual(after.effectiveManifestHash, before.effectiveManifestHash, "Effective Snapshot manifest hash");
assertEqual(after.resolverOutputHash, before.resolverOutputHash, "Resolver A output hash");
assertEqual(after.resolverRecordHash, before.resolverRecordHash, "Resolver A persisted record hash");
assertEqual(before.effectiveSnapshotRevision, 1, "phase A Effective Snapshot revision");
assertEqual(after.effectiveSnapshotRevision, 1, "phase B Effective Snapshot revision");
assertEqual(before.resolverCalls, 1, "phase A Resolver A calls");
assertEqual(before.consumerCalls, 0, "phase A Consumer B calls");
assertEqual(after.resolverCalls, 0, "phase B Resolver A calls");
assertEqual(after.consumerCalls, 1, "phase B Consumer B calls");
assertEqual(after.resultStatus, "COMPLETED", "recovered World Query status");
assertEqual(after.resolverRecordUnchanged, true, "Resolver A record stability");
if (!Number.isInteger(before.processId) || !Number.isInteger(after.processId)) {
  throw new Error("restart gate markers must include integer Node process ids");
}
if (before.processId === after.processId) {
  throw new Error("restart gate phases unexpectedly ran in the same Node process");
}

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  marker: "GOWM_V071_NODE_ADHERENCE_RESTART_READY",
  runId,
  queryId: before.queryId,
  jobId: before.jobId,
  separateGatewayProcesses: 2,
  postgresqlPersistence: true,
  resolverACommittedBeforeInterruption: true,
  resolverANotRerunAfterRestart: true,
  consumerBResumedAfterRestart: true,
  effectiveSnapshotRevision: 1,
  effectiveManifestHash: before.effectiveManifestHash,
  resolverOutputHash: before.resolverOutputHash,
  resolverRecordHash: before.resolverRecordHash,
  persistedEffectiveSnapshotReloaded: true,
  persistedNodeAdherenceReloaded: true
})}\n`);

function run(phase, expectedMarker) {
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "tests/integration/effective-snapshot-postgres.test.ts",
    "--reporter=dot",
    "--testNamePattern",
    "real WorldQueryRuntime restart"
  ], {
    cwd: root,
    env: { ...common, GOWM_V07_EFFECTIVE_SNAPSHOT_PHASE: phase },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (result.status !== 0) {
    throw new Error(`effective snapshot ${phase} process failed with exit code ${result.status ?? "unknown"}`);
  }
  return readMarker(`${stdout}\n${stderr}`, expectedMarker);
}

function readMarker(output, expectedMarker) {
  const matches = [];
  for (const line of output.split(/\r?\n/u)) {
    const firstBrace = line.indexOf("{");
    const lastBrace = line.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) continue;
    try {
      const candidate = JSON.parse(line.slice(firstBrace, lastBrace + 1));
      if (candidate?.marker === expectedMarker) matches.push(candidate);
    } catch {
      // Vitest may render non-JSON diagnostics with braces. Only the explicit
      // post-assertion marker is authoritative for this gate.
    }
  }
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${expectedMarker} marker, received ${matches.length}`);
  }
  return matches[0];
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
