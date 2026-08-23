import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const baselineSha = "d1ff3b81b8bf577965b00edc1bd06acaaeda706c";
const findings = [];

const baselineMigrations = readdirSync(join(repositoryRoot, "database", "migrations"))
  .filter((name) => /^(?:00[1-9]|010)_.+\.sql$/u.test(name))
  .sort();
if (baselineMigrations.length !== 10) {
  findings.push(`expected migrations 001-010, found ${baselineMigrations.length}`);
}
for (const name of baselineMigrations) {
  const path = `database/migrations/${name}`;
  try {
    const baselineBlob = git(["rev-parse", `${baselineSha}:${path}`]).trim();
    const workingBlob = git(["hash-object", "--path", path, path]).trim();
    if (baselineBlob !== workingBlob) findings.push(`${path} differs from locked baseline`);
  } catch (error) {
    findings.push(`${path} could not be compared to the locked baseline: ${errorMessage(error)}`);
  }
}

const candidateFiles = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  .split("\0")
  .filter(Boolean)
  .map((path) => path.replaceAll("\\", "/"));
for (const path of candidateFiles) {
  if (path === ".intake" || path.startsWith(".intake/")) {
    findings.push(`${path} exposes isolated intake source`);
  }
  if (/\.zip$/iu.test(path)) findings.push(`${path} is a ZIP in the release candidate inventory`);
  if (/(?:^|\/)(?:crs-normalization-service|geometry-tool-service|spatial-analysis-service)(?:\/|$)/iu.test(path)) {
    findings.push(`${path} appears to contain expanded external Provider source`);
  }
}

const expectedLocks = [
  {
    file: "contracts/manifests/providers/crs-provider-source-lock.json",
    shaField: "sourceSha256",
    sha: "3110e7b344d138908d27e759ede70701b8a20dd7bbbd9795b3a57d02b8d70995",
    licenseStatus: "UNSPECIFIED",
    redistributionAllowed: false
  },
  {
    file: "contracts/manifests/providers/geometry-provider-source-lock.json",
    shaField: "sourceSha256",
    sha: "3527a06d7a6216c1bf1c2ee75690824298231917c03a8c99507a71df26f12c3d",
    licenseStatus: "UNSPECIFIED",
    redistributionAllowed: false
  },
  {
    file: "contracts/manifests/providers/spatial-provider-source-lock.json",
    shaField: "sourceSha256",
    sha: "15cdaf00f3c5ee911eac1351c2d9a59ff06a5de93a176ce81b644b19ee5de322",
    licenseStatus: "APPROVED",
    redistributionAllowed: true,
    noticePath: "services/providers/spatial-provider-bridge/THIRD_PARTY_NOTICES.md",
    sbomPath: "services/providers/spatial-provider-bridge/sbom.cdx.json"
  },
  {
    file: "contracts/manifests/providers/h3-toolkit-source-lock.json",
    shaField: "sourceGitCommit",
    sha: "74fc8657072dd58a2f8e4317c1caef8bfd10e024",
    licenseStatus: "APPROVED",
    redistributionAllowed: true,
    noticePath: "packages/integrations/h3-toolkit-bridge/THIRD_PARTY_NOTICES.md",
    sbomPath: "packages/integrations/h3-toolkit-bridge/sbom.cdx.json"
  }
];
for (const expected of expectedLocks) {
  const lockPath = join(repositoryRoot, expected.file);
  if (!existsSync(lockPath)) {
    findings.push(`${expected.file} is missing`);
    continue;
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock[expected.shaField] !== expected.sha) findings.push(`${expected.file} source lock drifted`);
  if (lock.licenseStatus !== expected.licenseStatus) findings.push(`${expected.file} license status drifted`);
  if (lock.redistributionAllowed !== expected.redistributionAllowed) {
    findings.push(`${expected.file} redistribution policy drifted`);
  }
  for (const field of ["noticePath", "sbomPath"]) {
    const expectedPath = expected[field];
    if (expectedPath && (lock[field] !== expectedPath || !existsSync(join(repositoryRoot, expectedPath)))) {
      findings.push(`${expected.file} has a missing or mismatched ${field}`);
    }
  }
}

const manifestDirectory = join(repositoryRoot, "contracts", "manifests", "providers");
const manifestFiles = readdirSync(manifestDirectory)
  .filter((name) => name.endsWith("-provider.json"))
  .sort();
let operationCount = 0;
const providerIds = new Set();
for (const name of manifestFiles) {
  const manifest = JSON.parse(readFileSync(join(manifestDirectory, name), "utf8"));
  const providerId = manifest.provider?.providerId;
  if (typeof providerId !== "string" || providerIds.has(providerId)) {
    findings.push(`${name} has a missing or duplicate Provider ID`);
  } else {
    providerIds.add(providerId);
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(manifest.provider?.implementationDigest ?? "")) {
    findings.push(`${name} lacks a locked implementation digest`);
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    findings.push(`${name} has no capabilities`);
    continue;
  }
  operationCount += manifest.capabilities.length;
  for (const descriptor of manifest.capabilities) {
    for (const field of ["inputSchemaHash", "outputSchemaHash"]) {
      if (!/^sha256:[0-9a-f]{64}$/u.test(descriptor[field] ?? "")) {
        findings.push(`${name} ${descriptor.operationId ?? "unknown"} lacks ${field}`);
      }
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`${findings.map((finding) => `RELEASE_BOUNDARY_FAIL ${finding}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `RELEASE_BOUNDARIES_PASS providers=${providerIds.size} operations=${operationCount} migrationBaseline=${baselineMigrations.length}\n`
  );
}

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
}

function errorMessage(error) {
  return error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
}
