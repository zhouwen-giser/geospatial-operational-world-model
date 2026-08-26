import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const lock = JSON.parse(readFileSync(resolve(root, "reports/gowm-v0.6.1/r00-source-lock.json"), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: root });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const assert = (value, message) => { if (!value) throw new Error(message); };
assert(/^[0-9a-f]{40}$/u.test(lock.sourceSha), "invalid R00 source SHA");
assert(git("merge-base", "HEAD", lock.sourceSha).toString().trim() === lock.sourceSha, "candidate is not descended from actual R00 main");
assert(git("show", `${lock.sourceSha}:VERSION`).toString().trim() === "0.6.0", "actual R00 predecessor is not 0.6.0");
const paths = git("ls-tree", "-r", "--name-only", lock.sourceSha, "database/migrations", "contracts").toString().trim().split("\n");
const migrations = paths.filter((path) => /^database\/migrations\/\d{3}_.+\.sql$/u.test(path));
const contracts = paths.filter((path) => /^contracts\/gowm-v0\.[456]\//u.test(path));
assert(migrations.length === 53 && migrations.at(-1).startsWith("database/migrations/053_"), "R00 migrations must be exactly 001–053");
const files = {};
for (const path of [...migrations, ...contracts]) {
  const expected = digest(git("show", `${lock.sourceSha}:${path}`));
  const actual = digest(readFileSync(resolve(root, path)));
  assert(actual === expected, `R00 predecessor bytes changed: ${path}`);
  files[path] = expected;
}
writeFileSync(resolve(root, "reports/gowm-v0.6.1/r00-predecessor-byte-lock.json"), `${JSON.stringify({
  schemaVersion: "1.0", status: "PASS", sourceSha: lock.sourceSha,
  migrationCount: migrations.length, contractCount: contracts.length, files
}, null, 2)}\n`);
process.stdout.write(`GOWM_V061_PREDECESSOR_READY sha=${lock.sourceSha} migrations=${migrations.length} contracts=${contracts.length}\n`);
