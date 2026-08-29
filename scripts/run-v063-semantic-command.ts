import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const command = process.argv[2];
const targets: Record<string, string[]> = {
  materialize: ["scripts/materialize-capability-semantic-profiles.ts", "--write"],
  "validate-materializer": ["scripts/materialize-capability-semantic-profiles.ts"],
  "validate-registry": ["scripts/build-world-platform-registry.ts"]
};
const target = targets[command ?? ""];
if (!target) throw new Error(`Unknown v0.6.3 semantic command: ${String(command)}`);

const root = resolve(process.cwd());
const result = spawnSync(process.execPath, ["--import", "tsx", resolve(root, target[0]!), ...target.slice(1)], {
  cwd: root,
  env: { ...process.env, GOWM_REPORT_DIRECTORY: "reports/gowm-v0.6.3" },
  stdio: "inherit"
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
