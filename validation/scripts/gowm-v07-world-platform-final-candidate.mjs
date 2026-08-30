import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { semanticSourceFingerprint } from "../../packages/platform/semantic-conformance/src/index.ts";

const root = resolve(".");
const reportRoot = process.env.GOWM_REPORT_DIRECTORY?.trim();
if (reportRoot?.replaceAll("\\", "/") !== "reports/gowm-v0.7/pr1/world-platform") {
  throw new Error("GOWM_REPORT_DIRECTORY must select reports/gowm-v0.7/pr1/world-platform");
}
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const checks = {};
const verify = (name, condition) => {
  checks[name] = Boolean(condition);
  if (!condition) throw new Error(`GOWM v0.7 World Platform final gate failed: ${name}`);
};

await run(process.execPath, [resolve(root, "validation/scripts/gowm-v07-pr1-final-candidate.mjs")]);

const sourceDigest = await semanticSourceFingerprint(root);
const regression = await read(`${reportRoot}/regression/report.json`);
const vitest = await read(`${reportRoot}/regression/vitest.json`);
const blackBox = await read(`${reportRoot}/black-box-evidence.json`);
const runtime = await read(`${reportRoot}/runtime/semantic-black-box-report.json`);
const image = await read(`${reportRoot}/runtime/runtime-image-attestation.json`);
const canary = await read(`${reportRoot}/single-gateway-canary-report.json`);
const materializer = await read(`${reportRoot}/semantic-materializer-report.json`);
const semantics = await read(`${reportRoot}/semantic-conformance-report.json`);
const registry = await read(`${reportRoot}/world-platform-registry-build-report.json`);
const profile = await read(`${reportRoot}/world-platform-profile-report.json`);
const providers = await read(`${reportRoot}/provider-conformance/aggregate.json`);

verify("fresh-regression", regression.status === "PASS" && regression.sourceDigest === sourceDigest && regression.sourceAfter === sourceDigest && regression.commands.every((command) => command.status === "PASS"));
verify("vitest", vitest.success === true && vitest.numFailedTests === 0 && vitest.numPassedTests >= 400);
verify("fresh-black-box", blackBox.status === "PASS" && blackBox.sourceDigest === sourceDigest && runtime.status === "PASS" && runtime.sourceDigest === sourceDigest && Object.values(runtime.checks).every(Boolean));
verify("runtime-image", image.status === "PASS" && image.sourceDigest === sourceDigest && image.compiledFiles > 100 && Object.keys(image.files).length === image.compiledFiles);
verify("canaries", canary.status === "PASS" && canary.canaries.length === 5 && canary.canaries.every((item) => item.status === "PASS"));
verify("materializer", materializer.status === "PASS" && materializer.resolved.length === 122 && materializer.conflicts.length === 0 && materializer.insufficient.length === 0);
verify("semantic-conformance", semantics.status === "PASS" && Object.values(semantics.counters).every((value) => value === 0));
verify("registry", registry.status === "PASS" && registry.providerCount === 15 && registry.operationCount === 122 && registry.missingRequiredProviders.length === 0 && registry.operationCollisions.length === 0);
verify("profile", profile.status === "PASS" && Object.values(profile.checks).every(Boolean));
verify("provider-conformance", providers.status === "PASS" && providers.checks.every((item) => item.status === "PASS") && providers.providers.every((item) => item.status === "PASS"));
verify("pr1-version-boundary", (await readFile("VERSION", "utf8")).trim() === "0.6.3" && (await read("package.json")).version === "0.6.4");

const report = {
  status: "PASS",
  gate: "GOWM_V07_WORLD_PLATFORM_FINAL_CANDIDATE",
  sourceDigest,
  checks,
  protectedActions: [],
  sharedRuntimeMutated: false
};
await mkdir(reportRoot, { recursive: true });
await writeFile(`${reportRoot}/world-platform-final-report.json`, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`GOWM_V07_WORLD_PLATFORM_FINAL_PASS checks=${Object.keys(checks).length}\n`);

async function run(command, arguments_) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd: root, env: process.env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Required child gate failed (exit=${String(code)}, signal=${String(signal)})`));
    });
  });
}
