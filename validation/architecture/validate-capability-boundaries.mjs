import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const findings = [];

function sourceFiles(directory) {
  const absolute = join(repositoryRoot, directory);
  try {
    return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) return sourceFiles(relative(repositoryRoot, child));
      return [".ts", ".mts", ".js", ".mjs"].includes(extname(entry.name)) ? [child] : [];
    });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

function inspect(directory, rules) {
  for (const file of sourceFiles(directory)) {
    const content = readFileSync(file, "utf8");
    for (const [label, pattern] of rules) {
      if (pattern.test(content)) findings.push(`${relative(repositoryRoot, file)}: ${label}`);
    }
  }
}

inspect("services/gateway", [
  ["Gateway imports H3 engine", /(?:from\s+["']h3-js["']|require\(["']h3-js["']\))/],
  ["Gateway imports legacy Geometry engine", /packages[\\/]spatial-engine/],
  ["Gateway contains PROJ or GEOS binding", /(?:proj4|libproj|geos-wasm|@turf\/)/i],
  ["Gateway contains raw spatial SQL", /\b(?:ST_|h3_)[A-Za-z0-9_]*\s*\(/],
  ["Gateway imports Operational Reality domain code", /(?:packages[\\/]runtime[\\/]src[\\/]operational-|providers[\\/]operational-reality-provider)/]
]);

inspect("services/providers", [
  ["Provider imports a sibling provider", /services[\\/]providers[\\/](?![^\\/]+[\\/]src[\\/](?:\.\.\/?)*$)/],
  ["Provider imports Gateway implementation", /services[\\/]gateway/]
]);

for (const criticalPath of ["services/observation-ingest", "services/projection-worker"]) {
  inspect(criticalPath, [
    ["Foundation critical path imports Gateway", /services[\\/]gateway/],
    ["Foundation critical path imports remote provider", /services[\\/]providers/]
  ]);
}

for (const sourceRoot of ["packages", "services", "scripts", "simulator"]) {
  inspect(sourceRoot, [
    ["Upper-layer WSGS/SACS/SDAR/A2A dependency", /(?:from\s+["'][^"']*(?:wsgs|sacs|sdar|a2a)[^"']*["']|require\(["'][^"']*(?:wsgs|sacs|sdar|a2a)[^"']*["']\))/i]
  ]);
}

for (const file of sourceFiles("packages")) {
  const path = relative(repositoryRoot, file).replaceAll("\\", "/");
  const content = readFileSync(file, "utf8");
  if (
    /(?:from\s+["']h3-js["']|require\(["']h3-js["']\))/.test(content) &&
    !path.startsWith("packages/integrations/h3-toolkit-local/")
  ) {
    findings.push(`${path}: H3 engine import bypasses the locked Toolkit local adapter`);
  }
}

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repositoryRoot })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
for (const file of tracked) {
  if (file === ".intake" || file.startsWith(`.intake${sep}`) || file.startsWith(".intake/")) {
    findings.push(`${file}: isolated intake source is tracked`);
  }
}

const migrationDirectory = join(repositoryRoot, "database", "migrations");
for (const file of readdirSync(migrationDirectory)) {
  const fullPath = join(migrationDirectory, file);
  if (!statSync(fullPath).isFile()) continue;
  if (!/^\d{3}_.+\.sql$/.test(file)) findings.push(`${relative(repositoryRoot, fullPath)}: invalid migration filename`);
}

if (findings.length) {
  process.stderr.write(`${findings.map((entry) => `BOUNDARY_FAIL ${entry}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("CAPABILITY_BOUNDARIES_PASS\n");
}
