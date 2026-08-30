import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { assertPostMergeMainCi } from "./gowm-v071-ci-authority.mjs";
import {
  assertValidHistoricalConsumerLock,
  readHistoricalConsumerBindingAuthority,
  readVerifiedQualificationReport
} from "./gowm-v071-evidence-verification.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const command = process.argv[2];
const authority = assertPostMergeMainCi();
const identity = sourceIdentity();
const evidenceRoot = resolve(
  process.env.GOWM_V071_EVIDENCE_ROOT ?? resolve(root, "output", "gowm-v0.7.1", identity.commit)
);

if (command === "initialize") await initialize();
else if (command === "run") await runGate();
else if (command === "defer-artifact") await deferArtifact();
else if (command === "alias") await aliasReport();
else if (command === "finalize") await finalize();
else throw new Error("usage: gowm-v071-exact-head-evidence.mjs initialize|run|defer-artifact|alias|finalize");

async function initialize() {
  await mkdir(resolve(evidenceRoot, "logs"), { recursive: true });
  const clean = worktreeClean();
  const report = envelope("source-lock", clean ? "PASS" : "FAIL", {
    gate: "exact source identity",
    trackedWorktreeCleanAtStart: clean,
    marker: clean ? "GOWM_V071_EXACT_SOURCE_LOCKED" : "GOWM_V071_EXACT_SOURCE_DIRTY"
  });
  await writeReport("source-lock", report);
  if (!clean) throw new Error("exact-head qualification must start from a clean tracked worktree");
  process.stdout.write(`${JSON.stringify({ evidenceRoot, ...report })}\n`);
}

async function runGate() {
  const reportId = requiredReportId(process.argv[3]);
  const separator = process.argv.indexOf("--", 4);
  if (separator < 0 || separator === process.argv.length - 1) {
    throw new Error("run requires: <report-id> <gate-label> -- <command> [arguments]");
  }
  const gate = process.argv.slice(4, separator).join(" ").trim();
  if (gate.length === 0) throw new Error("gate label is required");
  if (!worktreeClean()) {
    throw new Error(`gate ${reportId} must start from a clean worktree, including staged and untracked files`);
  }
  const executable = process.argv[separator + 1];
  const arguments_ = process.argv.slice(separator + 2);
  const logPath = resolve(evidenceRoot, "logs", `${reportId}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "w" });
  const digest = createHash("sha256");
  let bytes = 0;
  const child = spawn(executable, arguments_, {
    cwd: root,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      digest.update(buffer);
      log.write(buffer);
      (stream === child.stdout ? process.stdout : process.stderr).write(buffer);
    });
  }
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null) reject(new Error(`gate ${reportId} terminated by ${signal}`));
      else resolvePromise(code ?? 1);
    });
  });
  await new Promise((resolvePromise, reject) => log.end((error) => error ? reject(error) : resolvePromise()));
  const trackedWorktreeCleanAfter = worktreeClean();
  const passed = exitCode === 0 && trackedWorktreeCleanAfter;
  const report = envelope(reportId, passed ? "PASS" : "FAIL", {
    gate,
    command: [executable, ...arguments_],
    exitCode,
    trackedWorktreeCleanAfter,
    log: {
      relativePath: `logs/${reportId}.log`,
      bytes,
      sha256: `sha256:${digest.digest("hex")}`
    },
    ...(exitCode === 0 && !trackedWorktreeCleanAfter
      ? { reason: "The gate changed tracked, staged, or untracked source state." }
      : {})
  });
  await writeReport(reportId, report);
  if (!passed) process.exitCode = exitCode === 0 ? 1 : exitCode;
}

async function deferArtifact() {
  const report = envelope("artifact-roundtrip-report", "DEFERRED", {
    gate: "scope-aware complete historical trajectory artifact round trip",
    marker: "GOWM_V071_HISTORICAL_ARTIFACT_DEFERRED",
    reason: "The v0.7.1 Provider deliberately omits artifactReference. Only trajectoryReferenceKey, bounded preview, gaps and completeness are exposed until an Artifact Registry round trip is implemented and qualified."
  });
  await writeReport("artifact-roundtrip-report", report);
}

async function aliasReport() {
  const reportId = requiredReportId(process.argv[3]);
  const sourceReportId = requiredReportId(process.argv[4]);
  const gate = process.argv.slice(5).join(" ").trim();
  if (gate.length === 0) throw new Error("alias gate label is required");
  const { report: source } = await readVerifiedQualificationReport({
    evidenceRoot,
    reportId: sourceReportId,
    commit: identity.commit,
    tree: identity.tree,
    ciSource: authority.ciSource,
    acceptedStatuses: ["PASS"]
  });
  if (source.log === undefined) throw new Error(`${sourceReportId} has no reusable immutable log`);
  const aliasLogPath = resolve(evidenceRoot, "logs", `${reportId}.log`);
  await writeFile(aliasLogPath, await readFile(resolve(evidenceRoot, source.log.relativePath)));
  await writeReport(reportId, envelope(reportId, "PASS", {
    gate,
    command: source.command,
    exitCode: source.exitCode,
    log: { ...source.log, relativePath: `logs/${reportId}.log` },
    trackedWorktreeCleanAfter: source.trackedWorktreeCleanAfter,
    reason: `The ${sourceReportId} execution directly covers this gate; this report reuses its immutable log digest without rerunning or weakening the check.`
  }));
}

async function finalize() {
  if (!worktreeClean()) {
    throw new Error("exact-head qualification cannot finalize from a dirty worktree");
  }
  const required = [
    "source-lock",
    "protocol-closure-report",
    "deterministic-hash-report",
    "database-fresh-report",
    "database-upgrade-report",
    "gateway-runtime-report",
    "node-adherence-report",
    "worker-backoff-report",
    "artifact-roundtrip-report",
    "historical-two-provider-dag-report",
    "wsgs-historical-consumer-lock"
  ];
  const checks = [];
  for (const reportId of required) {
    const acceptedStatuses = reportId === "artifact-roundtrip-report" ? ["DEFERRED"] : ["PASS"];
    const { report, bytes } = await readVerifiedQualificationReport({
      evidenceRoot,
      reportId,
      commit: identity.commit,
      tree: identity.tree,
      ciSource: authority.ciSource,
      acceptedStatuses
    });
    if (reportId === "wsgs-historical-consumer-lock") {
      const lockBytes = await readFile(resolve(evidenceRoot, "GOWM_HISTORICAL_CONSUMER_LOCK.json"));
      const lockDigest = `sha256:${createHash("sha256").update(lockBytes).digest("hex")}`;
      if (
        report.lock?.relativePath !== "GOWM_HISTORICAL_CONSUMER_LOCK.json"
        || report.lock.bytes !== lockBytes.length
        || report.lock.sha256 !== lockDigest
      ) {
        throw new Error("WSGS report does not bind the generated Historical Consumer Lock bytes");
      }
      const bindingAuthority = await readHistoricalConsumerBindingAuthority(root);
      assertValidHistoricalConsumerLock(JSON.parse(lockBytes.toString("utf8")), {
        ciSource: authority.ciSource,
        bindingRevision: bindingAuthority.bindingRevision,
        operations: bindingAuthority.operations,
        providerManifests: bindingAuthority.providerManifests
      });
    }
    checks.push({
      reportId,
      status: report.status,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    });
  }
  const report = envelope("final-closure-report", "PASS", {
    gate: "GOWM v0.7.1 exact-head protocol and runtime closure",
    marker: "GOWM_V0_7_1_PROTOCOL_AND_RUNTIME_CLOSURE_COMPLETE",
    checks
  });
  await writeReport("final-closure-report", report);
  await readVerifiedQualificationReport({
    evidenceRoot,
    reportId: "final-closure-report",
    commit: identity.commit,
    tree: identity.tree,
    ciSource: authority.ciSource,
    acceptedStatuses: ["PASS"]
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function sourceIdentity() {
  const commit = gitText(["rev-parse", "HEAD"]);
  const tree = gitText(["rev-parse", "HEAD^{tree}"]);
  if (authority.commit !== commit) {
    throw new Error(`GITHUB_SHA ${authority.commit} differs from checked-out HEAD ${commit}`);
  }
  return { commit, tree };
}

function envelope(reportId, status, fields = {}) {
  return {
    schemaVersion: "1.0",
    candidateCommit: identity.commit,
    candidateTree: identity.tree,
    generatedAt: new Date().toISOString(),
    evidenceAuthority: "IMMUTABLE_CI_ARTIFACT",
    ciSource: authority.ciSource,
    reportId,
    status,
    ...fields
  };
}

async function writeReport(reportId, report) {
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(resolve(evidenceRoot, `${reportId}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function requiredReportId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) {
    throw new Error("report id is invalid");
  }
  return value;
}

function gitText(arguments_) {
  const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${arguments_.join(" ")} failed`);
  return result.stdout.trim().toLowerCase();
}

function worktreeClean() {
  return gitText(["status", "--porcelain=v1", "--untracked-files=all"]).length === 0;
}
