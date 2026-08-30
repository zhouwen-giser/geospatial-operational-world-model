import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const directoryRoots = [
  "packages/platform/contract-runtime",
  "packages/platform/semantic-conformance",
  "packages/platform/result-validation-core/src",
  "packages/network-foundation/src",
  "packages/network-query-core/src",
  "packages/observation-model/src",
  "packages/runtime/src",
  "packages/road-coverage-planning-core/src",
  "packages/road-coverage-verifier-core/src",
  "packages/road-coverage-alternatives-core/src",
  "packages/integrations/h3-toolkit-bridge/src",
  "services/gateway/world-capability-gateway",
  "services/providers/grounding-catalog-provider/src",
  "services/providers/route-planning-provider/src",
  "services/stas/src/domain"
];
const forbidden = [
  ["localeCompare", /\.localeCompare\s*\(/u],
  ["Intl.Collator", /Intl\.Collator/u],
  ["toLocaleLowerCase", /toLocaleLowerCase/u],
  ["toLocaleUpperCase", /toLocaleUpperCase/u]
];

const candidates = [];
for (const directory of directoryRoots) candidates.push(...await sourceFiles(resolve(repositoryRoot, directory)));
for (const path of await sourceFiles(resolve(repositoryRoot, "scripts"))) {
  const relativePath = relative(resolve(repositoryRoot, "scripts"), path).replaceAll("\\", "/");
  if (
    /^(materialize-|generate-)/u.test(basename(path))
    || relativePath === "replay.ts"
    || relativePath.startsWith("sample-world/")
  ) candidates.push(path);
}

const violations = [];
for (const path of candidates) {
  const source = await readFile(path, "utf8");
  for (const [name, pattern] of forbidden) {
    if (pattern.test(source)) violations.push(`${relative(repositoryRoot, path).replaceAll("\\", "/")}: ${name}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Hash-critical ordering guard failed:\n${violations.map((entry) => `- ${entry}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`HASH_CRITICAL_ORDERING_PASS files=${candidates.length}\n`);
}

async function sourceFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["generated", "bundle", "dist", "node_modules", "coverage"].includes(entry.name)) {
        output.push(...await sourceFiles(path));
      }
    } else if ([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].includes(extname(entry.name))) {
      output.push(path);
    }
  }
  return output;
}
