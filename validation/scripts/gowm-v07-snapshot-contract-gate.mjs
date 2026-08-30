import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generator = resolve(root, "packages/platform/contract-runtime/scripts/generate-contract-types.mjs");
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");

await run(process.execPath, [generator, "--check"]);
await run(process.execPath, [
  vitest,
  "run",
  "tests/platform/gowm-v07-contracts.test.ts",
  "tests/platform/provider-snapshot-context.test.ts",
  "tests/platform/query-snapshot-merge.test.ts",
  "tests/platform/effective-snapshot-memory-store.test.ts",
  "--reporter=verbose"
]);

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  gate: "GOWM_V07_SNAPSHOT_CONTRACTS",
  checks: {
    generatedContractsCurrent: true,
    v063Compatibility: true,
    v07ContractExamples: true,
    descriptorSnapshotSemantics: true,
    providerSnapshotContext: true,
    deterministicSnapshotMerge: true,
    memoryAtomicCommit: true
  }
})}\n`);

async function run(command, arguments_) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`snapshot contract child gate failed (exit=${String(code)}, signal=${String(signal)})`));
    });
  });
}
