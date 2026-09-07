#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compileOpenDriveArtifacts, DEFAULT_OUTPUT_ROOT } from "../../packages/opendrive-network-compiler/src/index.js";
import { runAdmission } from "./admit.js";
import { runVerification } from "./verify.js";

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function compile(arguments_: readonly string[]): Promise<void> {
  if (arguments_.length !== 0 && arguments_.length !== 3) {
    throw new Error("usage: cli.js compile [<xodr> <oracle> <artifact-dir>]");
  }
  const sourcePath = arguments_[0] ?? process.env.OPENDRIVE_SOURCE_PATH;
  const oraclePath = arguments_[1] ?? process.env.OPENDRIVE_GEOREF_ORACLE_PATH;
  const artifactDirectory = resolve(arguments_[2] ?? process.env.GOWM_OPENDRIVE_OUTPUT_ROOT ?? DEFAULT_OUTPUT_ROOT);
  const result = await compileOpenDriveArtifacts({
    sourcePath: required(sourcePath, "OPENDRIVE_SOURCE_PATH"),
    oraclePath: required(oraclePath, "OPENDRIVE_GEOREF_ORACLE_PATH"),
    outputRoot: artifactDirectory
  });
  const admissionPlan = result.artifacts["admission-plan.json"] as Record<string, unknown>;
  const compileReport = result.artifacts["compile-report.json"] as Record<string, unknown>;
  const reportDirectory = dirname(artifactDirectory);
  const sourceLock = {
    schemaVersion: "1.0",
    status: "PASS",
    sourceArtifact: result.manifest.sourceArtifact,
    oracleArtifactHash: admissionPlan.oracleArtifactHash,
    transformContentHash: admissionPlan.transformContentHash,
    compilerVersion: admissionPlan.compilerVersion
  };
  await writeFile(resolve(reportDirectory, "SOURCE_LOCK.json"), `${JSON.stringify(sourceLock, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  await writeFile(resolve(reportDirectory, "COMPILE_REPORT.json"), `${JSON.stringify(compileReport, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    datasetReferenceKey: admissionPlan.datasetReferenceKey,
    datasetVersion: admissionPlan.datasetVersionKey,
    graphVersion: admissionPlan.graphVersionKey,
    contentHash: admissionPlan.contentHash,
    topologyHash: admissionPlan.topologyHash,
    counts: admissionPlan.counts
  })}\n`);
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "compile") return compile(arguments_);
  if (command === "admit") {
    const result = await runAdmission(process.env, arguments_);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === "FAIL" || result.status === "BLOCKED") process.exitCode = 1;
    return;
  }
  if (command === "verify" || command === "validate") {
    const status = await runVerification(process.env, arguments_);
    process.stdout.write(`${JSON.stringify({ status })}\n`);
    if (status === "FAIL" || status === "BLOCKED" || (command === "validate" && status !== "PASS")) process.exitCode = 1;
    return;
  }
  throw new Error("usage: cli.js compile [<xodr> <oracle> <artifact-dir>] | admit [<artifact-dir>] [--show-db-fingerprint] | verify [<artifact-dir>]");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
