import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsumerContracts } from "./build.mjs";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const walk = async (root) => (await Promise.all((await readdir(root, { withFileTypes: true })).map(async (entry) => {
  const path = join(root, entry.name);
  return entry.isDirectory() ? walk(path) : path;
}))).flat().sort();
const digestTree = async (root) => Promise.all((await walk(root)).map(async (path) => [relative(root, path), createHash("sha256").update(await readFile(path)).digest("hex")]));

const first = await mkdtemp(join(tmpdir(), "gowm-consumer-a-"));
const second = await mkdtemp(join(tmpdir(), "gowm-consumer-b-"));
try {
  await buildConsumerContracts(first);
  await buildConsumerContracts(second);
  const one = JSON.stringify(await digestTree(first));
  const two = JSON.stringify(await digestTree(second));
  if (one !== two) throw new Error("Two clean consumer contract builds produced different hashes");
  const installed = await digestTree(join(packageRoot, "bundle"));
  if (one !== JSON.stringify(installed)) throw new Error("Tracked consumer bundle is stale");
  const serialized = (await Promise.all((await walk(join(packageRoot, "bundle"))).map((path) => readFile(path, "utf8")))).join("\n");
  if (/https?:\/\/(?!json-schema\.org)|transportToken|databaseName|containerName|\/reports\/|\/logs\//u.test(serialized)) throw new Error("Consumer contract package leaks deployment/runtime metadata");
  process.stdout.write(`CONSUMER_CONTRACTS_PASS ${JSON.stringify({ files: installed.length })}\n`);
} finally {
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
}
