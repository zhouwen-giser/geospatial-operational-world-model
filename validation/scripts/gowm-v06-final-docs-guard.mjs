import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
const checks = {};
const requireText = async (path, fragments) => {
  const source = await readFile(resolve(root, path), "utf8");
  for (const fragment of fragments) check(`${path}:${fragment}`, source.includes(fragment));
  return source;
};

const version = (await readFile(resolve(root, "VERSION"), "utf8")).trim();
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
check("versionConvergence", version === "0.6.0" && packageJson.version === version && packageLock.version === version && packageLock.packages?.[""]?.version === version);

await requireText("CHANGELOG.md", ["## 0.6.0 - 2026-08-25", "ROAD_COVERAGE_READY", "OR-Tools"]);
await requireText("README.md", ["Version `0.6.0`", "NETWORK_READY", "ROUTING_READY", "ROAD_COVERAGE_READY", "routeCount > 1", "dispatchable", "licenseStatus=UNSPECIFIED"]);
await requireText("PROJECT_STATUS.md", ["GOWM+ 0.6.0", "NETWORK_READY", "ROUTING_READY", "ROAD_COVERAGE_READY", "F01 | PENDING", "Merge/tag/release/deploy"]);
await requireText("docs/adr/006-road-coverage-planning-authority.md", ["NO_SECOND_GRAPH", "NO_PROVIDER_TO_PROVIDER_HTTP", "EITHER_DIRECTION", "OR-Tools", "not dispatchable"]);
await requireText("docs/architecture/ROAD_COVERAGE_PLANNING_V0.6.md", ["R is not E", "SINGLE_ROUTE_V0_6", "COMPUTATIONAL_PLAN_NOT_PHYSICAL_FACT"]);
await requireText("docs/19_ROAD_COVERAGE_OPERATIONS_RUNBOOK.md", ["coverage.road.plan", "SOLVING, VERIFYING, and", "EITHER_DIRECTION", "not production SLO"]);

const schemas = (await readdir(resolve(root, "contracts/gowm-v0.6"))).filter((name) => name.endsWith(".schema.json"));
check("publicSchemaCount", schemas.length === 19);
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const prohibited = tracked.filter((path) => path.startsWith(".intake/") || path.startsWith("GOWM_Road_Coverage_Planning_v0.6_Codex_Goal/") || /area-road-coverage-planner-reference/iu.test(path));
check("referenceSourceExcluded", prohibited.length === 0);

const evidence = { schemaVersion: "1.0", phase: "F00", runId, status: "PASS", version, checks, trackedReferencePaths: prohibited, protectedActions: { merge: "NOT_RUN", tag: "NOT_RUN", release: "NOT_RUN", deploy: "NOT_RUN" } };
await mkdir(resolve(root, "reports/gowm-v0.6"), { recursive: true });
await writeFile(resolve(root, `reports/gowm-v0.6/f00-runtime-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`GOWM_V06_FINAL_DOCS_PASS ${runId} checks=${Object.keys(checks).length} version=${version}\n`);

function check(name, condition) {
  if (!condition) throw new Error(`${name} failed`);
  checks[name] = true;
}
