import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { loadModule, parseSync } from "pgsql-parser";
import { repositoryRoot } from "./gowm-v07-postgres-harness.js";

export const HISTORY_SQL_ASSERTIONS = {
  taskInterval: "database/tests/048_task_execution_intervals_assertions.sql",
  trackletFinalization: "database/tests/049_tracklet_finalization_runtime_assertions.sql",
  historicalTrajectory: "database/tests/050_historical_trajectory_contract_assertions.sql"
} as const;

export type HistorySqlAssertion = keyof typeof HISTORY_SQL_ASSERTIONS;

export interface HistorySqlAssertionEvidence {
  assertion: HistorySqlAssertion;
  file: string;
  sha256: `sha256:${string}`;
  psqlMetaLinesRemoved: number;
}

export interface SqlAssertionFileEvidence {
  file: string;
  sha256: `sha256:${string}`;
  psqlMetaLinesRemoved: number;
}

export async function runHistorySqlAssertions(
  databaseUrl: string,
  assertions: readonly HistorySqlAssertion[]
): Promise<HistorySqlAssertionEvidence[]> {
  if (assertions.length === 0) throw new Error("at least one history SQL assertion is required");
  const files = assertions.map((assertion) => HISTORY_SQL_ASSERTIONS[assertion]);
  const executed = await runSqlAssertionFiles(databaseUrl,files);
  return executed.map((item,index) => ({
    assertion: assertions[index]!,
    ...item
  }));
}

export async function runSqlAssertionFiles(
  databaseUrl: string,
  files: readonly string[]
): Promise<SqlAssertionFileEvidence[]> {
  if (files.length === 0) throw new Error("at least one SQL assertion file is required");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: "gowm-v07-history-assertion-gate",
    max: 1,
    connectionTimeoutMillis: 5_000
  });
  const evidence: SqlAssertionFileEvidence[] = [];
  try {
    await loadModule();
    for (const file of files) {
      const source = await readFile(resolve(repositoryRoot, file), "utf8");
      const lines = source.split(/\r?\n/u);
      const psqlMetaLines = lines.filter((line) => /^\s*\\/u.test(line));
      const executableSql = lines
        .filter((line) => !/^\s*\\/u.test(line))
        .join("\n");
      if (executableSql.trim().length === 0) {
        throw new Error(`${file} does not contain an executable assertion batch`);
      }
      try {
        const statements = splitSqlStatements(executableSql);
        if (statements.length === 0) throw new Error("SQL parser returned no statements");
        for (const statement of statements) await pool.query(statement);
      } catch (error) {
        throw new Error(`history SQL assertion failed: ${file}`, { cause: error });
      }
      evidence.push({
        file,
        sha256: `sha256:${createHash("sha256").update(source).digest("hex")}`,
        psqlMetaLinesRemoved: psqlMetaLines.length
      });
    }
  } finally {
    await pool.end();
  }
  return evidence;
}

function splitSqlStatements(source: string): string[] {
  const bytes = Buffer.from(source, "utf8");
  const statements = parseSync(source).stmts ?? [];
  return statements.map((statement, index) => {
    const start = statement.stmt_location ?? 0;
    const followingStart = statements[index + 1]?.stmt_location ?? bytes.length;
    const length = statement.stmt_len ?? 0;
    const end = length > 0 ? start + length : followingStart;
    return bytes.subarray(start, end).toString("utf8").trim();
  }).filter((statement) => statement.length > 0);
}

export function focusedHistoryTests(
  required: readonly string[],
  optional: readonly string[] = []
): string[] {
  for (const file of required) {
    if (!existsSync(resolve(repositoryRoot, file))) {
      throw new Error(`required focused history test is missing: ${file}`);
    }
  }
  return [
    ...required,
    ...optional.filter((file) => existsSync(resolve(repositoryRoot, file)))
  ];
}

export function historyGateEnvironment(
  databaseUrl: string,
  runId: string
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    GOWM_V07_DATABASE_URL: databaseUrl,
    RUN_GOWM_V07_DB_INTEGRATION: "1",
    GOWM_V07_RUN_ID: runId
  };
}
