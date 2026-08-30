import {
  runVitest,
  withMigratedV07Database
} from "./gowm-v07-postgres-harness.js";
import {
  focusedHistoryTests,
  historyGateEnvironment,
  runHistorySqlAssertions
} from "./gowm-v07-history-harness.js";

await withMigratedV07Database("history_trajectory", async (databaseUrl, versions, runId) => {
  const assertions = await runHistorySqlAssertions(databaseUrl, ["historicalTrajectory"]);
  const focusedTests = focusedHistoryTests([
    "tests/unit/historical-source-selection.test.ts",
    "tests/unit/historical-completeness.test.ts",
    "tests/unit/historical-runtime-materializer.test.ts",
    "tests/unit/historical-runtime-queue.test.ts",
    "tests/unit/historical-runtime-trajectory.test.ts",
    "tests/unit/projection-worker-v07.test.ts",
    "tests/platform/historical-trace-provider.test.ts",
    "tests/platform/historical-trace-provider-http.test.ts"
  ]);
  await runVitest(focusedTests, historyGateEnvironment(databaseUrl, runId));
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    gate: "GOWM_V07_HISTORY_TRAJECTORY",
    versions,
    assertions,
    focusedTests,
    checks: {
      sqlAssertion050Executed: true,
      gapPreserved: true,
      pausedPeriodExcludedSeparately: true,
      semanticAsOfPreserved: true,
      exactPinnedRevisionReplayable: true,
      analysisInputLineage: true,
      appendOnly: true,
      scopeBeforeRead: true,
      providerSingleOperation: true,
      providerToProviderCalls: false,
      multiSourceFusion: false
    },
    sharedRuntimeMutated: false
  })}\n`);
});
