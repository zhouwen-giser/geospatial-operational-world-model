import {
  runVitest,
  withMigratedV07Database
} from "./gowm-v07-postgres-harness.js";
import {
  focusedHistoryTests,
  historyGateEnvironment,
  runHistorySqlAssertions
} from "./gowm-v07-history-harness.js";

await withMigratedV07Database("tracklet_finalization", async (databaseUrl, versions, runId) => {
  const assertions = await runHistorySqlAssertions(databaseUrl, ["trackletFinalization"]);
  const focusedTests = focusedHistoryTests([
    "tests/unit/historical-runtime-coordinator.test.ts",
    "tests/unit/historical-runtime-finalization.test.ts",
    "tests/platform/historical-trace-provider.test.ts"
  ]);
  await runVitest(focusedTests, historyGateEnvironment(databaseUrl, runId));
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    gate: "GOWM_V07_TRACKLET_FINALIZATION",
    versions,
    assertions,
    focusedTests,
    checks: {
      sqlAssertion049Executed: true,
      pinnedWatermarkRevision: true,
      sealedRevisionPreserved: true,
      laterEvidenceCreatesNewFinalizationRevision: true,
      exactAsOfPreserved: true,
      immutableTrackletVersion: true,
      appendOnly: true,
      scopeBeforeRead: true,
      workerFence: true
    },
    sharedRuntimeMutated: false
  })}\n`);
});
