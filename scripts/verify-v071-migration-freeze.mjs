import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const migrationRoot = resolve("database", "migrations");
const lock = JSON.parse(await readFile(resolve("database", "gowm-v071-migration-freeze-lock.json"), "utf8"));
if (lock.lockVersion !== "1.0" || lock.baseline !== "gowm-v0.7.0-migration-head-067") {
  throw new Error("the GOWM v0.7.1 migration freeze lock has an unsupported identity");
}

const frozenFiles = (await readdir(migrationRoot))
  .filter((name) => /^\d{3}_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/u.test(name))
  .filter((name) => Number(name.slice(0, 3)) <= 67)
  .sort();
const lockedFiles = Object.keys(lock.migrations).sort();
if (
  frozenFiles.length !== 67
  || lockedFiles.length !== 67
  || frozenFiles[0] !== "001_initial_schema.sql"
  || frozenFiles.at(-1) !== "067_historical_trajectory_contract.sql"
  || JSON.stringify(frozenFiles) !== JSON.stringify(lockedFiles)
) {
  throw new Error("migrations 001 through 067 differ from the frozen file set");
}

for (const name of frozenFiles) {
  const actual = createHash("sha256").update(await readFile(resolve(migrationRoot, name))).digest("hex");
  if (actual !== lock.migrations[name]) {
    throw new Error(`${name} differs from the frozen GOWM v0.7.0 migration bytes`);
  }
}

process.stdout.write(`${JSON.stringify({
  marker: "GOWM_V071_MIGRATIONS_001_067_FROZEN",
  baseline: lock.baseline,
  migrationCount: frozenFiles.length,
  migrationHead: frozenFiles.at(-1)
})}\n`);
