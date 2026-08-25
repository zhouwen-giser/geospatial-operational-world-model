import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ignored = new Set([".git", "coverage", "dist", "node_modules"]);
const findings = [];

function files(directory) {
  const absolute = resolve(repositoryRoot, directory);
  try {
    return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      if (ignored.has(entry.name)) return [];
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) return files(relative(repositoryRoot, child));
      return [".ts", ".mts", ".js", ".mjs", ".sql", ".json", ".yaml", ".yml"].includes(extname(entry.name))
        ? [child]
        : [];
    });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}
function inspect(directory, rules) {
  for (const file of files(directory)) {
    const content = readFileSync(file, "utf8");
    for (const [label, pattern] of rules) {
      if (pattern.test(content)) findings.push(`${relative(repositoryRoot, file)}: ${label}`);
    }
  }
}

const architecture = readFileSync(resolve(repositoryRoot, "docs/architecture/ROAD_COVERAGE_PLANNING_V0.6.md"), "utf8");
const adr = readFileSync(resolve(repositoryRoot, "docs/adr/006-road-coverage-planning-authority.md"), "utf8");
for (const marker of [
  "V0_5_NETWORK_AUTHORITY",
  "NO_SECOND_GRAPH",
  "NO_PROVIDER_TO_PROVIDER_HTTP",
  "INDEPENDENT_COVERAGE_VERIFIER",
  "SINGLE_ROUTE_V0_6",
  "COMPUTATIONAL_PLAN_NOT_PHYSICAL_FACT",
]) {
  if (!architecture.includes(marker) && !adr.includes(marker)) findings.push(`architecture: missing ${marker}`);
}

inspect("services/gateway", [
  ["Gateway contains coverage solver/verifier algorithm", /\b(?:closed[-_ ]?dcpp|open[-_ ]?dcpp|rural[-_ ]postman|coverage[-_ ]verifier|service[-_ ]obligation[-_ ]ledger|route[-_ ]inspection)\b/i],
]);

inspect("services/providers/road-coverage-provider", [
  ["Coverage Provider contains an HTTP client", /\b(?:fetch|axios|undici|got)\s*(?:\.|\()/i],
  ["Coverage Provider imports Network Provider implementation", /services[\\/]providers[\\/]network-provider/],
  ["Coverage Provider imports Route Provider implementation", /services[\\/]providers[\\/]route-planning-provider/],
]);

inspect("packages/road-coverage-verifier", [
  ["Independent verifier imports Coverage Solver", /(?:road-coverage-(?:core|solver)|services[\\/]providers[\\/]road-coverage-provider).*(?:solver|ledger|path-builder|route-construction)/i],
]);

inspect("database/migrations", [
  ["Coverage schema creates a second network authority table", /create\s+table\s+(?:if\s+not\s+exists\s+)?coverage_planner\.(?:graph_version|road_arc|turn_transition|turn_sequence_restriction)\b/i],
]);

if (findings.length) {
  process.stderr.write(`${findings.map((finding) => `ROAD_COVERAGE_BOUNDARY_FAIL ${finding}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("ROAD_COVERAGE_BOUNDARIES_PASS\n");
}
