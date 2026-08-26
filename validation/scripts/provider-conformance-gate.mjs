import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
try {
  execFileSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./provider-conformance-gate.ts", import.meta.url)), ...process.argv.slice(2)], { stdio: "inherit" });
} catch (error) {
  const out = resolve(process.env.GOWM_CONFORMANCE_OUTPUT_DIRECTORY ?? fileURLToPath(new URL("../../reports/gowm-v0.6.1/provider-conformance", import.meta.url)));
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, "aggregate.json"), `${JSON.stringify({ schemaVersion: "1.0", status: "FAIL", generatedAt: new Date().toISOString(), reason: "Executable conformance gate failed; previous PASS is invalid", exitCode: error.status ?? 1 }, null, 2)}\n`);
  process.exitCode = 1;
}
