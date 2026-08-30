import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { validateContract } from "../../packages/platform/contract-runtime/src/index.js";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const HASH = `sha256:${"c".repeat(64)}`;
const CI_SOURCE = {
  githubRepository: "zhouwen-giser/geospatial-operational-world-model",
  githubWorkflowRef: "zhouwen-giser/geospatial-operational-world-model/.github/workflows/gowm-v071-exact-head-qualification.yml@refs/heads/main",
  githubRunId: "123456789",
  githubRunAttempt: "2"
} as const;
const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("GOWM v0.7.1 exact-head evidence contracts", () => {
  it("accepts a candidate-bound immutable CI gate report", () => {
    const report = {
      schemaVersion: "1.0",
      candidateCommit: COMMIT,
      candidateTree: TREE,
      generatedAt: "2026-08-30T12:00:00.000Z",
      evidenceAuthority: "IMMUTABLE_CI_ARTIFACT",
      ciSource: CI_SOURCE,
      reportId: "node-adherence-report",
      status: "PASS",
      gate: "persisted node adherence restart",
      command: ["npm", "test"],
      exitCode: 0,
      log: {
        relativePath: "logs/node-adherence-report.log",
        bytes: 42,
        sha256: HASH
      },
      trackedWorktreeCleanAfter: true
    };
    expect(validateContract("urn:gowm:v0.7.1:exact-head-qualification-report", report)).toMatchObject({ valid: true });
    expect(validateContract("urn:gowm:v0.7.1:exact-head-qualification-report", {
      ...report,
      trackedWorktreeCleanAfter: false
    })).toMatchObject({ valid: false });
    expect(validateContract("urn:gowm:v0.7.1:exact-head-qualification-report", {
      ...report,
      exitCode: 1
    })).toMatchObject({ valid: false });
    expect(validateContract("urn:gowm:v0.7.1:exact-head-qualification-report", {
      ...report,
      ciSource: { ...CI_SOURCE, githubRepository: "fork/repository" }
    })).toMatchObject({ valid: false });
  });

  it("accepts the bounded WSGS Historical Consumer Baseline and rejects non-exact source", () => {
    const lock = {
      schemaVersion: "1.0",
      candidateCommit: COMMIT,
      candidateTree: TREE,
      ciSource: CI_SOURCE,
      bindingRevision: HASH,
      consumerContractPackage: {
        name: "@gowm/world-gateway-contracts",
        version: "0.7.1",
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        contractCatalogRevision: HASH,
        semanticCatalogHash: HASH
      },
      providerManifests: [
        provider("gowm.historical-trace"),
        provider("gowm.operational-reality")
      ],
      operations: [
        operation("history.get-trajectory"),
        operation("operational-task.get-execution-intervals")
      ],
      snapshotBehavior: {
        scopeModel: "SINGLE_SCOPE_V1",
        resourceIdEncodingRevision: "SNAPSHOT_RESOURCE_ID_V1_512",
        canonicalOrderingRevision: "UNICODE_CODE_POINT_BINARY_V1"
      },
      migrationHead: "068_effective_snapshot_consistency_downgrade.sql",
      runtimeQualificationEvidenceDigest: HASH,
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
    expect(validateContract("urn:gowm:v0.7.1:wsgs-historical-consumer-lock", lock)).toMatchObject({ valid: true });
    expect(validateContract("urn:gowm:v0.7.1:wsgs-historical-consumer-lock", {
      ...lock,
      candidateCommit: "local-head"
    })).toMatchObject({ valid: false });
    expect(validateContract("urn:gowm:v0.7.1:wsgs-historical-consumer-lock", {
      ...lock,
      providerManifests: [provider("gowm.historical-trace"), provider("gowm.historical-trace")]
    })).toMatchObject({ valid: false });
    expect(validateContract("urn:gowm:v0.7.1:wsgs-historical-consumer-lock", {
      ...lock,
      operations: [operation("history.get-trajectory"), operation("history.get-trajectory")]
    })).toMatchObject({ valid: false });
    expect(validateContract("urn:gowm:v0.7.1:wsgs-historical-consumer-lock", {
      ...lock,
      bindingRevision: "not-a-binding-revision"
    })).toMatchObject({ valid: false });
    expect(validateContract("urn:gowm:v0.7.1:wsgs-historical-consumer-lock", {
      ...lock,
      allowedConsumerCapabilities: lock.allowedConsumerCapabilities.slice(0, -1)
    })).toMatchObject({ valid: false });
    expect(validateContract("urn:gowm:v0.7.1:wsgs-historical-consumer-lock", {
      ...lock,
      explicitNonClaims: [...lock.explicitNonClaims.slice(0, -1), "MAP_MATCHING"]
    })).toMatchObject({ valid: false });
  });

  it("selects each required PREVIEW operation once across default and preview collections", () => {
    const previewOperations = [
      publishedOperation("history.get-trajectory"),
      publishedOperation("operational-task.get-execution-intervals")
    ];
    const accepted = runOperationSelection({ defaultOperations: [], previewOperations });
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual([
      expect.objectContaining({
        operationId: "history.get-trajectory",
        providerId: "gowm.historical-trace",
        maturity: "PREVIEW"
      }),
      expect.objectContaining({
        operationId: "operational-task.get-execution-intervals",
        providerId: "gowm.operational-reality",
        maturity: "PREVIEW"
      })
    ]);

    const missing = runOperationSelection({ defaultOperations: [], previewOperations: previewOperations.slice(0, 1) });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("must publish exactly one operational-task.get-execution-intervals");

    const drifted = runOperationSelection({
      defaultOperations: [],
      previewOperations: [{ ...previewOperations[0]!, maturity: "STABLE" }, previewOperations[1]!]
    });
    expect(drifted.status).not.toBe(0);
    expect(drifted.stderr).toContain("maturity drifted from PREVIEW");

    const duplicated = runOperationSelection({
      defaultOperations: [previewOperations[0]!],
      previewOperations
    });
    expect(duplicated.status).not.toBe(0);
    expect(duplicated.stderr).toContain("must publish exactly one history.get-trajectory; found 2");
  });

  it("rejects valid-looking binding, operation and CI source drift from authoritative inputs", () => {
    const lock = historicalLockFixture();
    const accepted = runHistoricalLockBindingVerification(lock, lock);
    expect(accepted.status).toBe(0);

    const bindingDrift = runHistoricalLockBindingVerification(
      { ...lock, bindingRevision: `sha256:${"d".repeat(64)}` },
      lock
    );
    expect(bindingDrift.status).not.toBe(0);
    expect(bindingDrift.stderr).toContain("bindingRevision drifted");

    const operationDrift = runHistoricalLockBindingVerification({
      ...lock,
      operations: lock.operations.map((item, index) => index === 0
        ? { ...item, outputSchemaHash: `sha256:${"d".repeat(64)}` }
        : item)
    }, lock);
    expect(operationDrift.status).not.toBe(0);
    expect(operationDrift.stderr).toContain("operation bindings drifted");

    const sourceDrift = runHistoricalLockBindingVerification({
      ...lock,
      ciSource: { ...CI_SOURCE, githubRunAttempt: "3" }
    }, lock);
    expect(sourceDrift.status).not.toBe(0);
    expect(sourceDrift.stderr).toContain("CI source identity drifted");
  });

  it("accepts only the canonical repository workflow run as CI evidence authority", () => {
    const accepted = runCiAuthority();
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ commit: COMMIT, ciSource: CI_SOURCE });

    for (const environment of [
      { GITHUB_REPOSITORY: "fork/geospatial-operational-world-model" },
      { GITHUB_WORKFLOW_REF: `${CI_SOURCE.githubRepository}/.github/workflows/other.yml@refs/heads/main` },
      { GITHUB_RUN_ID: "0" },
      { GITHUB_RUN_ATTEMPT: "" }
    ]) {
      const rejected = runCiAuthority(environment);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("canonical GitHub Actions workflow");
    }
  });

  it.each([
    "validation/scripts/gowm-v071-exact-head-evidence.mjs",
    "validation/scripts/gowm-v071-wsgs-historical-lock.mjs"
  ])("refuses authoritative evidence generation outside post-merge main CI: %s", (script) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve(repositoryRoot, script), "initialize"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "false",
        GITHUB_REF: "refs/heads/codex/local-candidate",
        GITHUB_REF_NAME: "codex/local-candidate",
        GITHUB_SHA: ""
      },
      windowsHide: true
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("may only be generated by the canonical GitHub Actions workflow on refs/heads/main");
  });

  it("binds accepted command evidence to the immutable log bytes", async () => {
    const evidenceRoot = await mkdtemp(resolve(tmpdir(), "gowm-v071-evidence-"));
    try {
      const reportId = "gateway-runtime-report";
      const logBytes = Buffer.from("qualified gateway output\n", "utf8");
      await mkdir(resolve(evidenceRoot, "logs"), { recursive: true });
      await writeFile(resolve(evidenceRoot, "logs", `${reportId}.log`), logBytes);
      const report = {
        schemaVersion: "1.0",
        candidateCommit: COMMIT,
        candidateTree: TREE,
        generatedAt: "2026-08-30T12:00:00.000Z",
        evidenceAuthority: "IMMUTABLE_CI_ARTIFACT",
        ciSource: CI_SOURCE,
        reportId,
        status: "PASS",
        gate: "real Gateway runtime",
        command: ["npm", "run", "validate:v07-history-gateway"],
        exitCode: 0,
        log: {
          relativePath: `logs/${reportId}.log`,
          bytes: logBytes.length,
          sha256: `sha256:${createHash("sha256").update(logBytes).digest("hex")}`
        },
        trackedWorktreeCleanAfter: true
      };
      await writeFile(resolve(evidenceRoot, `${reportId}.json`), `${JSON.stringify(report)}\n`);

      expect(runEvidenceVerification(evidenceRoot, reportId).status).toBe(0);
      await writeFile(resolve(evidenceRoot, "logs", `${reportId}.log`), "tampered\n");
      const tampered = runEvidenceVerification(evidenceRoot, reportId);
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain("log bytes or digest differ");

      await writeFile(resolve(evidenceRoot, "logs", `${reportId}.log`), logBytes);
      await writeFile(resolve(evidenceRoot, `${reportId}.json`), `${JSON.stringify({
        ...report,
        ciSource: { ...CI_SOURCE, githubRunAttempt: "3" }
      })}\n`);
      const sourceDrift = runEvidenceVerification(evidenceRoot, reportId);
      expect(sourceDrift.status).not.toBe(0);
      expect(sourceDrift.stderr).toContain("not accepted exact-source evidence");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});

function runEvidenceVerification(evidenceRoot: string, reportId: string) {
  const helperUrl = pathToFileURL(resolve(repositoryRoot, "validation/scripts/gowm-v071-evidence-verification.mjs")).href;
  const source = [
    `import { readVerifiedQualificationReport } from ${JSON.stringify(helperUrl)};`,
    "await readVerifiedQualificationReport({",
    "  evidenceRoot: process.env.TEST_EVIDENCE_ROOT,",
    "  reportId: process.env.TEST_REPORT_ID,",
    `  commit: ${JSON.stringify(COMMIT)},`,
    `  tree: ${JSON.stringify(TREE)},`,
    `  ciSource: ${JSON.stringify(CI_SOURCE)},`,
    "  acceptedStatuses: ['PASS']",
    "});"
  ].join("\n");
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TEST_EVIDENCE_ROOT: evidenceRoot,
      TEST_REPORT_ID: reportId
    },
    windowsHide: true
  });
}

function runOperationSelection(consumerLock: Record<string, unknown>) {
  const helperUrl = pathToFileURL(resolve(repositoryRoot, "validation/scripts/gowm-v071-evidence-verification.mjs")).href;
  const source = [
    `import { selectHistoricalConsumerOperations } from ${JSON.stringify(helperUrl)};`,
    "const lock = JSON.parse(process.env.TEST_CONSUMER_LOCK);",
    "process.stdout.write(JSON.stringify(selectHistoricalConsumerOperations(lock)));"
  ].join("\n");
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, TEST_CONSUMER_LOCK: JSON.stringify(consumerLock) },
    windowsHide: true
  });
}

function runHistoricalLockBindingVerification(
  lock: unknown,
  expected: unknown
) {
  const helperUrl = pathToFileURL(resolve(repositoryRoot, "validation/scripts/gowm-v071-evidence-verification.mjs")).href;
  const source = [
    `import { assertValidHistoricalConsumerLock } from ${JSON.stringify(helperUrl)};`,
    "const lock = JSON.parse(process.env.TEST_HISTORICAL_LOCK);",
    "const expected = JSON.parse(process.env.TEST_EXPECTED_HISTORICAL_LOCK);",
    "assertValidHistoricalConsumerLock(lock, {",
    "  ciSource: expected.ciSource,",
    "  bindingRevision: expected.bindingRevision,",
    "  operations: expected.operations,",
    "  providerManifests: expected.providerManifests",
    "});"
  ].join("\n");
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TEST_HISTORICAL_LOCK: JSON.stringify(lock),
      TEST_EXPECTED_HISTORICAL_LOCK: JSON.stringify(expected)
    },
    windowsHide: true
  });
}

function runCiAuthority(overrides: Record<string, string> = {}) {
  const helperUrl = pathToFileURL(resolve(repositoryRoot, "validation/scripts/gowm-v071-ci-authority.mjs")).href;
  const source = [
    `import { assertPostMergeMainCi } from ${JSON.stringify(helperUrl)};`,
    "process.stdout.write(JSON.stringify(assertPostMergeMainCi()));"
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REF_NAME: "main",
      GITHUB_SHA: COMMIT,
      GITHUB_REPOSITORY: CI_SOURCE.githubRepository,
      GITHUB_WORKFLOW_REF: CI_SOURCE.githubWorkflowRef,
      GITHUB_RUN_ID: CI_SOURCE.githubRunId,
      GITHUB_RUN_ATTEMPT: CI_SOURCE.githubRunAttempt,
      ...overrides
    },
    windowsHide: true
  });
}

function historicalLockFixture() {
  return {
    schemaVersion: "1.0",
    candidateCommit: COMMIT,
    candidateTree: TREE,
    ciSource: CI_SOURCE,
    bindingRevision: HASH,
    consumerContractPackage: {
      name: "@gowm/world-gateway-contracts",
      version: "0.7.1",
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      contractCatalogRevision: HASH,
      semanticCatalogHash: HASH
    },
    providerManifests: [provider("gowm.historical-trace"), provider("gowm.operational-reality")],
    operations: [operation("history.get-trajectory"), operation("operational-task.get-execution-intervals")],
    snapshotBehavior: {
      scopeModel: "SINGLE_SCOPE_V1",
      resourceIdEncodingRevision: "SNAPSHOT_RESOURCE_ID_V1_512",
      canonicalOrderingRevision: "UNICODE_CODE_POINT_BINARY_V1"
    },
    migrationHead: "068_effective_snapshot_consistency_downgrade.sql",
    runtimeQualificationEvidenceDigest: HASH,
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
  } as const;
}

function publishedOperation(operationId: "history.get-trajectory" | "operational-task.get-execution-intervals") {
  const { providerId: _providerId, ...published } = operation(operationId);
  return published;
}

function provider(providerId: "gowm.historical-trace" | "gowm.operational-reality") {
  return {
    providerId,
    providerVersion: "0.7.1",
    implementationDigest: HASH,
    manifestHash: HASH
  };
}

function operation(operationId: "history.get-trajectory" | "operational-task.get-execution-intervals") {
  return {
    operationId,
    providerId: operationId === "history.get-trajectory" ? "gowm.historical-trace" : "gowm.operational-reality",
    operationVersion: "1.0",
    inputSchemaHash: HASH,
    outputSchemaHash: HASH,
    semanticProfileHash: HASH,
    maturity: "PREVIEW"
  };
}
