import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  repositoryRoot,
  withMigratedV07Database,
  withUpgradedV07Database
} from "./gowm-v07-postgres-harness.js";
import {
  HISTORY_SQL_ASSERTIONS,
  runHistorySqlAssertions,
  runSqlAssertionFiles
} from "./gowm-v07-history-harness.js";

const startedAt = new Date().toISOString();
const combinedFinal = process.env.GOWM_V07_COMBINED_FINAL === "1";
const assertionFiles = (await readdir(resolve(repositoryRoot,"database/tests")))
  .filter((name) => /^\d{3}_.+_assertions\.sql$/u.test(name))
  // This gate certifies the byte-frozen v0.7 migration head (067).  Assertion
  // 052 belongs to the additive v0.7.1 migration 069 read contract and is run
  // by the v0.7.1 database-upgrade gate instead.
  .filter((name) => Number(name.slice(0,3))<=51)
  .sort()
  .map((name) => `database/tests/${name}`);
const securityAssertionFile = "database/tests/051_historical_security_negative_assertions.sql";
if (assertionFiles.length !== 51) {
  throw new Error(`expected 51 database assertion files, found ${assertionFiles.length}`);
}
if (!assertionFiles.includes(securityAssertionFile)) {
  throw new Error(`required database assertion is missing: ${securityAssertionFile}`);
}

const historyFiles = new Set<string>(Object.values(HISTORY_SQL_ASSERTIONS));
const freshFiles = combinedFinal
  ? assertionFiles.filter((file) => !historyFiles.has(file))
  : assertionFiles;

let freshEvidence: unknown;
let freshAssertions: unknown;
await withMigratedV07Database("database_regression", async (databaseUrl,evidence) => {
  freshEvidence = evidence;
  freshAssertions = await runSqlAssertionFiles(databaseUrl,freshFiles);
});

let upgradeEvidence: unknown;
let upgradeAssertions: unknown;
await withUpgradedV07Database("database_regression", async (databaseUrl,evidence) => {
  upgradeEvidence = evidence;
  upgradeAssertions = await runHistorySqlAssertions(databaseUrl,[
    "taskInterval",
    "trackletFinalization",
    "historicalTrajectory"
  ]);
});

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  gate: "GOWM_V07_DATABASE_REGRESSION",
  startedAt,
  endedAt: new Date().toISOString(),
  fresh: {
    evidence: freshEvidence,
    assertionCount: Array.isArray(freshAssertions) ? freshAssertions.length : 0,
    excludesHistoryAssertionsForCombinedFinal: combinedFinal
  },
  upgrade: {
    evidence: upgradeEvidence,
    assertionCount: Array.isArray(upgradeAssertions) ? upgradeAssertions.length : 0
  },
  sharedRuntimeMutated: false
})}\n`);
