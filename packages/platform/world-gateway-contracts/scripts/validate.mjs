import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsumerContracts } from "./build.mjs";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../../..");
const sourceLockPath = resolve(repositoryRoot, "contracts/consumers/wsgs-southbound-operation-lock-v2.json");
const bundledLockPath = "locks/wsgs-southbound-operation-lock-v2.json";
const walk = async (root) => (await Promise.all((await readdir(root, { withFileTypes: true })).map(async (entry) => {
  const path = join(root, entry.name);
  return entry.isDirectory() ? walk(path) : path;
}))).flat().sort();
const digestTree = async (root) => Promise.all((await walk(root)).map(async (path) => [relative(root, path), createHash("sha256").update(await readFile(path)).digest("hex")]));

const initialRepositoryStatus = repositoryStatus();
const initialSourceLock = await readFile(sourceLockPath);
const first = await mkdtemp(join(tmpdir(), "gowm-consumer-a-"));
const second = await mkdtemp(join(tmpdir(), "gowm-consumer-b-"));
let failure;
try {
  await buildConsumerContracts(first, { writeSourceLock: false });
  await buildConsumerContracts(second, { writeSourceLock: false });
  const one = JSON.stringify(await digestTree(first));
  const two = JSON.stringify(await digestTree(second));
  if (one !== two) throw new Error("Two clean consumer contract builds produced different hashes");
  const expectedLock = await readFile(join(first, bundledLockPath));
  const sourceLock = await readFile(sourceLockPath);
  if (!initialSourceLock.equals(sourceLock)) throw new Error("Consumer contract validation modified the tracked source lock");
  if (!expectedLock.equals(sourceLock)) throw new Error("Tracked consumer source lock is stale");
  const installed = await digestTree(join(packageRoot, "bundle"));
  if (one !== JSON.stringify(installed)) throw new Error("Tracked consumer bundle is stale");
  const compatibility = JSON.parse(await readFile(join(first, "compatibility/report.json"), "utf8"));
  if (
    typeof compatibility.classification === "string"
    && compatibility.classification.startsWith("BREAKING")
    && (!Array.isArray(compatibility.breakingChanges)
      || compatibility.breakingChanges.length === 0
      || compatibility.breakingChanges.some((entry) => typeof entry !== "string" || entry.trim().length === 0))
  ) {
    throw new Error("Breaking compatibility report must list non-empty breaking changes");
  }
  const serialized = (await Promise.all((await walk(join(packageRoot, "bundle"))).map((path) => readFile(path, "utf8")))).join("\n");
  if (/https?:\/\/(?!json-schema\.org)|transportToken|databaseName|containerName|\/reports\/|\/logs\//u.test(serialized)) throw new Error("Consumer contract package leaks deployment/runtime metadata");
} catch (error) {
  failure = error;
} finally {
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
}

const finalRepositoryStatus = repositoryStatus();
if (initialRepositoryStatus !== finalRepositoryStatus) {
  throw new Error("Consumer contract validation changed repository dirty state", { cause: failure });
}
if (failure !== undefined) throw failure;

const installed = await digestTree(join(packageRoot, "bundle"));
process.stdout.write(`CONSUMER_CONTRACTS_PASS ${JSON.stringify({ files: installed.length })}\n`);

function repositoryStatus() {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true
  });
}
