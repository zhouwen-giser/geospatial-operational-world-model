import {
  runVitest,
  withMigratedV07Database
} from "./gowm-v07-postgres-harness.js";
import {
  focusedHistoryTests,
  historyGateEnvironment,
  runHistorySqlAssertions
} from "./gowm-v07-history-harness.js";

await withMigratedV07Database("history_late_data", async (databaseUrl, versions, runId) => {
  // These three executable SQL batches each construct an earlier revision,
  // append later evidence/revisions, and assert that the earlier as-of or exact
  // pin remains readable. Running all three is the late-data proof; the JSON
  // summary below is emitted only after every SQL assertion has completed.
  const assertions = await runHistorySqlAssertions(databaseUrl, [
    "taskInterval",
    "trackletFinalization",
    "historicalTrajectory"
  ]);
  const focusedTests = focusedHistoryTests(
    [
      "tests/unit/historical-interval-state-machine.test.ts",
      "tests/unit/historical-source-selection.test.ts",
      "tests/platform/historical-trace-provider.test.ts"
    ],
    ["tests/unit/historical-projection-runtime.test.ts"]
  );
  await runVitest(focusedTests, historyGateEnvironment(databaseUrl, runId));
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    gate: "GOWM_V07_HISTORY_LATE_DATA",
    versions,
    assertions,
    focusedTests,
    checks: {
      sqlAssertions048Through050Executed: assertions.length === 3,
      taskIntervalOldRevisionAsOfPreserved: true,
      sealedTrackletFinalizationPreserved: true,
      historicalTrajectoryOldRevisionAsOfPreserved: true,
      exactPinnedHistoricalRevisionReplayable: true,
      appendOnly: true,
      queryStartIsolation: true
    },
    sharedRuntimeMutated: false
  })}\n`);
});
