import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const directoryRoots = [
  "packages/platform/contract-runtime",
  "packages/platform/semantic-conformance",
  "services/gateway/world-capability-gateway"
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
  if (/^(materialize-|generate-)/u.test(basename(path))) candidates.push(path);
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
      if (entry.name !== "generated" && entry.name !== "bundle") output.push(...await sourceFiles(path));
    } else if ([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].includes(extname(entry.name))) {
      output.push(path);
    }
  }
  return output;
}
