import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET_VERSION = "0.6.4";
const BASELINE_COMMIT = "17dd221330d9af540ec815a39eca96550690299a";
const EXPECTED_BRANCH = "codex/gowm-v0.6.4-reference-composability";
const COMMITTED_COMPATIBILITY_PATH = "reports/gowm-v0.6.4/contract-compatibility-evidence.json";
const MIGRATION_062_DIGEST = "sha256:7b8a606e3258baa2f3e68c88e81abacb289615cf960a1af20c8a9f4c2074539c";
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BARE_DIGEST = /^[0-9a-f]{64}$/u;
const WSGS_CASE_IDS = ["R1", "R2", "R3", "R4", "R5"];
const NON_CLAIMS = ["PRODUCTION_READY", "RELEASE_ACCEPTED", "FULL_QUALIFICATION_COMPLETE"];

class DeliveryError extends Error {}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node validation/scripts/gowm-v064-delivery-evidence.mjs " +
      "--candidate <commit> --compatibility <json> --baseline <json> --upgrade <json> " +
      "--runtime <json> --wsgs <json> --output <json>\n"
    );
    process.exit(0);
  }

  const candidateCommit = requiredCommit(options.candidate, "qualification candidate");
  assertLocalCommit(candidateCommit, "qualification candidate");
  const entries = Object.fromEntries(await Promise.all(
    ["compatibility", "baseline", "upgrade", "runtime", "wsgs"].map(async (name) => [
      name,
      await readEvidence(options[name], name)
    ])
  ));
  const compatibility = entries.compatibility.value;
  const baseline = entries.baseline.value;
  const upgrade = entries.upgrade.value;
  const runtime = entries.runtime.value;
  const wsgs = entries.wsgs.value;

  assertCompatibility(compatibility, candidateCommit);
  assertBaseline(baseline, candidateCommit);
  assertUpgrade(upgrade, baseline, candidateCommit);
  assertRuntime(runtime, upgrade, candidateCommit);
  const wsgsMode = assertWsgs(wsgs, candidateCommit);

  const head = requiredCommit(git(["rev-parse", "HEAD"]).trim(), "delivery HEAD");
  const branch = git(["branch", "--show-current"]).trim();
  if (branch !== EXPECTED_BRANCH) {
    throw new DeliveryError(`Delivery branch must be ${EXPECTED_BRANCH}`);
  }
  if (head === candidateCommit || !isAncestor(candidateCommit, head)) {
    throw new DeliveryError("Delivery HEAD must be a reports-only descendant of the source qualification candidate");
  }
  const postCandidatePaths = lines(git(["diff", "--name-only", candidateCommit, head, "--"]))
    .map(normalizePath);
  if (postCandidatePaths.length === 0 ||
      postCandidatePaths.some((path) => !path.startsWith("reports/gowm-v0.6.4/"))) {
    throw new DeliveryError("C->E delivery commits must change only reports/gowm-v0.6.4 artifacts");
  }
  const trackedChanges = lines(git(["status", "--porcelain=v1", "--untracked-files=all"]));
  if (trackedChanges.length !== 0) {
    throw new DeliveryError("Worktree changes, including untracked files, must be empty before producing external delivery evidence");
  }
  if (git(["show", `${candidateCommit}:VERSION`]).trim() !== TARGET_VERSION) {
    throw new DeliveryError("Qualification candidate VERSION is not 0.6.4");
  }
  const tagsAtHead = lines(git(["tag", "--points-at", head]));
  if (tagsAtHead.length !== 0) {
    throw new DeliveryError("Delivery HEAD must not have a Git tag");
  }
  const committedCompatibility = gitJson(candidateCommit, COMMITTED_COMPATIBILITY_PATH);
  if (canonicalSha256(committedCompatibility) !== canonicalSha256(compatibility)) {
    throw new DeliveryError("Compatibility evidence does not equal the candidate-committed artifact");
  }

  const findings = scanForSecrets({ compatibility, baseline, upgrade, runtime, wsgs });
  if (findings.length !== 0) {
    throw new DeliveryError("Evidence credential scan failed");
  }

  const pr = ghPullRequest();
  if (!Number.isInteger(pr.number) || pr.number <= 0 || pr.state !== "OPEN" ||
      pr.isDraft !== true || pr.headRefName !== EXPECTED_BRANCH || pr.headRefOid !== head) {
    throw new DeliveryError("GitHub pull request must be Draft, OPEN, and point at the exact delivery HEAD/branch");
  }

  const generatedAt = new Date().toISOString();
  const evidenceHashes = Object.fromEntries(Object.entries(entries).map(([name, entry]) => [
    name,
    entry.sha256
  ]));
  const reportCore = {
    schemaVersion: "1.0",
    targetVersion: TARGET_VERSION,
    qualificationCandidateCommit: candidateCommit,
    deliveryEvidenceCommit: head,
    branch,
    generatedAt,
    status: "PASS",
    evidenceHashes,
    sourceIdentity: {
      baselineCommit: BASELINE_COMMIT,
      candidateIsAncestor: true,
      sourceCommit: candidateCommit,
      reportsCommit: head,
      postCandidateChangeClass: "REPORTS_ONLY",
      postCandidateReportCount: postCandidatePaths.length,
      postCandidateReportPathsHash: canonicalSha256(postCandidatePaths),
      trackedWorktreeChanges: 0
    },
    draftPullRequest: {
      number: pr.number,
      state: pr.state,
      isDraft: pr.isDraft,
      headCommit: pr.headRefOid,
      branch: pr.headRefName,
      url: pr.url,
      remoteVerified: true,
      verifiedAt: generatedAt
    },
    protectedActions: {
      merge: false,
      tag: false,
      release: false,
      deploy: false,
      forcePush: false,
      tagsAtDeliveryHead: 0,
      basis: "This evidence generator performs read-only Git/GitHub inspection and writes one local JSON artifact."
    },
    credentialScan: {
      status: "PASS",
      rawCredentialCount: 0,
      scannedEvidenceCount: Object.keys(entries).length,
      scannedEvidenceHashes: evidenceHashes,
      policy: "NO_CREDENTIALS_NO_RAW_REFERENCE_IDS"
    },
    wsgsEnvironmentAvailable: wsgs.environmentAvailable,
    wsgsOutcome: wsgsMode,
    productionClaimsAbsent: true,
    nonClaims: NON_CLAIMS
  };
  const report = { ...reportCore, evidenceHash: canonicalSha256(reportCore) };
  if (scanForSecrets(report).length !== 0) {
    throw new DeliveryError("Generated delivery evidence contains prohibited sensitive material");
  }
  const outputPath = resolve(root, options.output);
  const inputPaths = new Set(Object.values(entries).map((entry) => entry.path));
  if (inputPaths.has(outputPath)) throw new DeliveryError("Delivery output must not overwrite input evidence");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `GOWM_V064_DELIVERY_EVIDENCE_PASS pr=${pr.number} candidate=${candidateCommit} head=${head} evidence=${report.evidenceHash}\n`
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function assertCompatibility(value, candidateCommit) {
  const operations = Array.isArray(value?.operations) ? value.operations : [];
  const ids = operations.map((entry) => entry?.operationId);
  if (value?.schemaVersion !== "1.0" || value?.status !== "PASS" ||
      value.baseline?.source !== BASELINE_COMMIT || value.baseline?.version !== "0.6.3" ||
      value.target?.version !== TARGET_VERSION ||
      ![candidateCommit, "WORKTREE_CONTENT"].includes(value.target?.source) ||
      value.migrationLock?.frozenCount !== 61 || value.migrationLock?.unchanged !== true ||
      value.migrationLock?.beforeHash !== value.migrationLock?.afterHash ||
      canonical(ids) !== canonical(["reference.resolve", "world.get-geometry"]) ||
      value.wsgsAdapter?.changeRequired !== false) {
    throw new DeliveryError("Compatibility evidence is not the passing v0.6.3-to-v0.6.4 lock");
  }
  requiredDigest(value.migrationLock.beforeHash, "compatibility migration lock");
  for (const operation of operations) {
    if (operation.operationVersion !== "1.0" || operation.schemaCompatible !== true ||
        operation.implementationIdentityRefreshed !== true ||
        operation.implementationDigestBefore === operation.implementationDigestAfter) {
      throw new DeliveryError(`Compatibility operation ${operation.operationId} is not safely refreshed`);
    }
    [operation.implementationDigestBefore, operation.implementationDigestAfter,
      operation.inputSchema?.beforeHash, operation.inputSchema?.afterHash,
      operation.outputSchema?.beforeHash, operation.outputSchema?.afterHash]
      .forEach((digest) => requiredDigest(digest, `compatibility ${operation.operationId}`));
    if (operation.inputSchema.beforeHash !== operation.inputSchema.afterHash ||
        operation.outputSchema.beforeHash !== operation.outputSchema.afterHash ||
        operation.inputSchema.compatible !== true || operation.outputSchema.compatible !== true ||
        operation.semanticProfile?.compatible !== true) {
      throw new DeliveryError(`Compatibility operation ${operation.operationId} changed its public wire contract`);
    }
  }
}

function assertBaseline(value, candidateCommit) {
  if (value?.schemaVersion !== "1.0" || value?.status !== "PASS" || value?.phase !== "baseline" ||
      value.candidateCommit !== candidateCommit || value.migrationCount !== 61 ||
      value.migration062Applied !== false ||
      value.baselineDivergence?.descriptorPresent !== true ||
      value.baselineDivergence?.descriptorCurrentObjectVersion !== true ||
      value.baselineDivergence?.sameReferenceGeometryRows !== 0 ||
      value.baselineDivergence?.defectReproduced !== true) {
    throw new DeliveryError("Baseline evidence does not reproduce the exact 001-061 defect");
  }
  ["databaseIdentityHash", "qualificationPreflightHash", "qualificationPreflightArtifactSha256",
    "sourceFixtureHash", "realizationHash", "zoneReferenceHash", "descriptorVersionHash",
    "featureVersionHash"].forEach((name) => requiredDigest(value[name], `baseline.${name}`));
  if (!BARE_DIGEST.test(String(value.loadedStateHash))) {
    throw new DeliveryError("baseline.loadedStateHash is not a bare SHA-256 digest");
  }
}

function assertUpgrade(value, baseline, candidateCommit) {
  if (value?.schemaVersion !== "1.0" || value?.status !== "PASS" || value?.phase !== "upgraded" ||
      value.candidateCommit !== candidateCommit || value.migrationCount !== 62 ||
      value.migration062Applied !== true || value.sameDatabaseUpgrade !== true ||
      value.migration062?.version !== "062_reference_geometry_composability.sql" ||
      value.migration062?.executedSqlChecksum !== MIGRATION_062_DIGEST ||
      value.descriptorPinComposes !== true || value.immutableFeaturePinComposes !== true ||
      value.currentFeatureGeometryRows !== 1 || value.databaseAssertions?.status !== "PASS" ||
      value.databaseAssertions?.filesPassed !== 45 || value.databaseAssertions?.total !== 45) {
    throw new DeliveryError("Upgrade evidence is not an exact passing migration-062 qualification");
  }
  for (const name of ["candidateCommit", "databaseIdentityHash", "qualificationPreflightHash",
    "sourceFixtureHash", "realizationHash", "realizationId", "loadedStateHash", "zoneReferenceHash"]) {
    if (baseline[name] !== value[name]) throw new DeliveryError(`Baseline/upgrade identity differs at ${name}`);
  }
  if (value.baselineEvidenceHash !== canonicalSha256(baseline)) {
    throw new DeliveryError("Upgrade baselineEvidenceHash differs from the supplied baseline evidence");
  }
}

function assertRuntime(value, upgrade, candidateCommit) {
  const core = { ...value };
  delete core.evidenceHash;
  if (value?.schemaVersion !== "1.0" || value?.targetVersion !== TARGET_VERSION || value?.status !== "PASS" ||
      value.candidateCommit !== candidateCommit || value.sourceIdentity?.gitHead !== candidateCommit ||
      value.sourceIdentity?.imageOciRevision !== candidateCommit || value.sourceIdentity?.imageOciVersion !== TARGET_VERSION ||
      value.runtime?.class !== "ISOLATED_Q" || value.runtime?.ready !== true ||
      value.freshClone !== true || value.freshDatabase !== true || value.manualPatchApplied !== false ||
      !availabilityTwelve(value.requiredAvailability) || value.canary?.status !== "PASS" ||
      value.canary?.passed !== 37 || value.canary?.total !== 37 ||
      value.database?.migrationCount !== 62 || value.fixture?.sourceFixtureHash !== upgrade.sourceFixtureHash ||
      value.evidenceHash !== canonicalSha256(core)) {
    throw new DeliveryError("Runtime evidence is not exact-candidate fresh-clone 12/12 and 37/37 proof");
  }
}

function assertWsgs(value, candidateCommit) {
  if (value?.schemaVersion !== "1.0" || value?.targetVersion !== TARGET_VERSION ||
      value?.candidateCommit !== candidateCommit || !Array.isArray(value.cases) ||
      value.cases.length !== 5 || canonical(value.cases.map((entry) => entry?.id)) !== canonical(WSGS_CASE_IDS)) {
    throw new DeliveryError("WSGS evidence candidate identity or ordered R1-R5 set is invalid");
  }
  const statuses = new Set(value.cases.map((entry) => entry?.status));
  if (value.status === "PASS") {
    if (statuses.size !== 1 || !statuses.has("PASS") || value.environmentAvailable !== true ||
        value.realResolverOutputConsumed !== true || value.gatewayReady !== true ||
        !availabilityTwelve(value.requiredAvailability) || value.gowmImageOciRevision !== candidateCommit ||
        value.chains?.zoneReferencePassedUnchanged !== true ||
        value.chains?.vehicleReferencePassedUnchanged !== true ||
        value.chains?.currentValidationUsable !== true || !isTimestamp(value.generatedAt)) {
      throw new DeliveryError("WSGS PASS evidence lacks exact-candidate real-chain proof");
    }
    return "PASS";
  }
  const allowedReasons = new Set([
    "WSGS_ENVIRONMENT_UNAVAILABLE", "WSGS_ENDPOINT_UNAVAILABLE", "WSGS_RUNTIME_UNAVAILABLE"
  ]);
  if (value.status !== "NOT_RUN" || statuses.size !== 1 || !statuses.has("NOT_RUN") ||
      value.environmentAvailable !== false || !allowedReasons.has(value.reasonCode) ||
      value.unavailabilityEvidence?.status !== "UNAVAILABLE" ||
      value.unavailabilityEvidence?.candidateCommit !== candidateCommit ||
      !DIGEST.test(String(value.unavailabilityEvidence?.evidenceHash)) ||
      !isTimestamp(value.unavailabilityEvidence?.observedAt)) {
    throw new DeliveryError("WSGS NOT_RUN evidence is not observed and candidate-bound");
  }
  return "NOT_RUN";
}

function parseArguments(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const names = ["candidate", "compatibility", "baseline", "upgrade", "runtime", "wsgs", "output"];
  const allowed = new Set(names);
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new DeliveryError(`Invalid argument near ${flag ?? "<end>"}`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name) || Object.hasOwn(result, name)) {
      throw new DeliveryError(`Unknown or duplicate option: ${flag}`);
    }
    result[name] = value;
  }
  for (const name of names) {
    if (!result[name]) throw new DeliveryError(`--${name} is required`);
  }
  return result;
}

async function readEvidence(path, label) {
  const absolute = resolve(root, path);
  const bytes = await readFile(absolute);
  try {
    return {
      path: absolute,
      value: JSON.parse(bytes.toString("utf8")),
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    };
  } catch {
    throw new DeliveryError(`${label} evidence is not valid JSON`);
  }
}

function ghPullRequest() {
  const result = spawnSync("gh", [
    "pr", "view", "--json", "number,state,isDraft,headRefName,headRefOid,url"
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new DeliveryError("Unable to verify the current branch pull request through GitHub CLI");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new DeliveryError("GitHub CLI returned invalid pull request JSON");
  }
}

function gitJson(commit, path) {
  try {
    return JSON.parse(git(["show", `${commit}:${path}`]));
  } catch {
    throw new DeliveryError("Qualification candidate lacks committed compatibility evidence");
  }
}

function requiredCommit(value, label) {
  if (typeof value !== "string" || !SOURCE_COMMIT.test(value)) {
    throw new DeliveryError(`${label} is not a lowercase 40-hex commit`);
  }
  return value;
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new DeliveryError(`${label} is not a SHA-256 digest`);
  }
  return value;
}

function assertLocalCommit(commit, label) {
  if (spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true
  }).status !== 0) {
    throw new DeliveryError(`${label} is not available in the local repository`);
  }
}

function isAncestor(ancestor, descendant) {
  return spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true
  }).status === 0;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
}

function scanForSecrets(value) {
  const findings = [];
  const visit = (item, path) => {
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        const sensitiveKey = /(?:password|passwd|authorization|(?:^|[_-])token(?:$|[_-])|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|(?:^|[_-])secret(?:$|[_-])|api[_-]?key|database[_-]?url|connection[_-]?string)/iu.test(key);
        if (sensitiveKey && child !== false && child !== null && child !== 0 && child !== "") {
          findings.push(`${path}.${key}`);
        }
        if (/^(?:referenceId|reference_id|candidateReferenceKey|candidate_reference_key)$/u.test(key) &&
            (typeof child !== "string" || !DIGEST.test(child))) {
          findings.push(`${path}.${key}`);
        }
        if (key === "referenceKey" && child && typeof child === "object" &&
            !Object.hasOwn(child, "beforeHash") && !Object.hasOwn(child, "afterHash")) {
          findings.push(`${path}.${key}`);
        }
        visit(child, `${path}.${key}`);
      }
      return;
    }
    if (typeof item === "string" && [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
      /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu,
      /\b(?:postgres|postgresql):\/\/[^/\s:@]+:[^@\s/]+@/iu,
      /\bghp_[A-Za-z0-9]{20,}\b/u,
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
      /\bwrf_[A-Za-z0-9_-]{8,}\b/u
    ].some((pattern) => pattern.test(item))) {
      findings.push(path);
    }
  };
  visit(value, "$");
  return findings;
}

function availabilityTwelve(value) {
  return value === "12/12" ||
    (value?.status === "PASS" && value?.passed === 12 && value?.total === 12);
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function lines(value) {
  return value.split(/\r?\n/u).filter(Boolean);
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function canonicalSha256(value) {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
