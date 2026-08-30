import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gates = [
  ["snapshot-contracts", [resolve(root, "validation/scripts/gowm-v07-snapshot-contract-gate.mjs")]],
  ["effective-snapshot", ["--import", "tsx", resolve(root, "validation/scripts/gowm-v07-effective-snapshot-e2e.ts")]],
  ["analysis-inputs", ["--import", "tsx", resolve(root, "validation/scripts/gowm-v07-analysis-resource-inputs-e2e.ts")]]
];

const completed = [];
for (const [name, arguments_] of gates) {
  process.stdout.write(`GOWM_V07_PR1_GATE_START ${name}\n`);
  await run(process.execPath, arguments_);
  completed.push(name);
  process.stdout.write(`GOWM_V07_PR1_GATE_PASS ${name}\n`);
}

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  gate: "GOWM_V07_PR1_FINAL_CANDIDATE",
  actualChildGatesExecuted: completed,
  historicalAlgorithmsImplemented: false,
  sharedRuntimeMutated: false
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
      else reject(new Error(`PR-1 child gate failed (exit=${String(code)}, signal=${String(signal)})`));
    });
  });
}
