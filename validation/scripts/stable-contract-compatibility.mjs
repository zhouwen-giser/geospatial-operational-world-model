import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const lock = JSON.parse(await readFile(
  resolve(root, "contracts/gowm-v0.4/source-package-lock.json"),
  "utf8"
));

assert.equal(lock.lockVersion, "1.0");
assert.equal(lock.softwareVersion, "0.4.0");
assert.equal(Object.keys(lock.artifacts).length, 33);

for (const [sourcePath, expected] of Object.entries(lock.artifacts)) {
  const installedPath = sourcePath.startsWith("contracts/")
    ? resolve(root, "contracts/gowm-v0.4", sourcePath.slice("contracts/".length))
    : sourcePath.startsWith("manifests/")
      ? resolve(root, "contracts/gowm-v0.4", sourcePath)
      : resolve(root, "contracts/platform", sourcePath);
  const bytes = await readFile(installedPath);
  const canonicalBytes = Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
  const actual = createHash("sha256").update(canonicalBytes).digest("hex");
  assert.equal(actual, expected, `${sourcePath} differs from the source-package lock`);
}

for (const manifestName of [
  "reference-catalog-provider.json",
  "dataset-catalog-provider.json",
  "world-evidence-provider.json",
  "operational-reality-provider.json"
]) {
  const manifest = JSON.parse(await readFile(
    resolve(root, "contracts/gowm-v0.4/manifests/providers", manifestName),
    "utf8"
  ));
  assert.ok(manifest.operations.length > 0, `${manifestName} must declare operations`);
  assert.ok(manifest.operations.every((operation) => operation.operationVersion === "1.0"));
}

process.stdout.write(`STABLE_CONTRACT_COMPATIBILITY_PASS artifacts=${Object.keys(lock.artifacts).length} version=0.4.0\n`);
