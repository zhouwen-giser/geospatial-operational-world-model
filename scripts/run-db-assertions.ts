import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../packages/world-model-core/src/config.js";

const { Pool } = pg;

export async function runDatabaseAssertions(pattern = /^\d{3}_.+_assertions\.sql$/): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  const directory = resolve(process.cwd(), "database/tests");
  const files = (await readdir(directory)).filter((name) => pattern.test(name)).sort();
  if (!files.length) throw new Error("No database assertion files matched");
  try {
    for (const file of files) {
      const source = await readFile(resolve(directory, file), "utf8");
      const sql = source
        .split(/\r?\n/u)
        .filter((line) => !line.trimStart().startsWith("\\"))
        .join("\n");
      await pool.query(sql);
      process.stdout.write(`DB_ASSERTIONS_PASS ${file}\n`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runDatabaseAssertions().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
