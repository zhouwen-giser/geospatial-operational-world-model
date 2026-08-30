import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const reportRoot = process.env.GOWM_REPORT_DIRECTORY?.trim() ?? "reports/gowm-v0.6.2";
const script = reportRoot?.replaceAll("\\", "/").includes("reports/gowm-v0.7/pr1/world-platform")
  ? "gowm-v07-world-platform-final-candidate.mjs"
  : "world-platform-final-candidate.mjs";

await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", resolve(root, "validation/scripts", script), ...process.argv.slice(2)], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`World Platform final candidate failed (exit=${String(code)}, signal=${String(signal)})`));
  });
});
