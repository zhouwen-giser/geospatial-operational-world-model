import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadModule, parseSync } from "pgsql-parser";

const migrations = resolve(process.cwd(), "database/migrations");
const databaseTests = resolve(process.cwd(), "database/tests");
const srid = process.env.ANALYSIS_SRID ?? "32650";
if (!/^\d+$/.test(srid) || Number(srid) <= 0) throw new Error("ANALYSIS_SRID must be a positive integer");

await loadModule();
for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
  const sql = (await readFile(resolve(migrations, file), "utf8"))
    .replaceAll(":ANALYSIS_SRID", srid)
    .replaceAll(":TRACKLET_MAX_TIME_GAP_MS", process.env.TRACKLET_MAX_TIME_GAP_MS ?? "10000")
    .replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", process.env.TRACKLET_MAX_DISTANCE_GAP_M ?? "250")
    .replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", process.env.TRACKLET_MAX_REQUIRED_SPEED_MPS ?? "80");
  parseSync(sql);
  process.stdout.write(`SQL AST PASS ${file}\n`);
}
for (const file of (await readdir(databaseTests)).filter((name) => name.endsWith(".sql")).sort()) {
  const sql = (await readFile(resolve(databaseTests,file),"utf8"))
    .replace(/^\\.*$/gm,"");
  parseSync(sql);
  process.stdout.write(`SQL AST PASS tests/${file}\n`);
}
