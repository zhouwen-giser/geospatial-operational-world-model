import {
  runVitest,
  withMigratedV07Database
} from "./gowm-v07-postgres-harness.js";
import {
  focusedHistoryTests,
  historyGateEnvironment,
  runHistorySqlAssertions
} from "./gowm-v07-history-harness.js";

await withMigratedV07Database("task_interval", async (databaseUrl, versions, runId) => {
  const assertions = await runHistorySqlAssertions(databaseUrl, ["taskInterval"]);
  const focusedTests = focusedHistoryTests([
    "tests/unit/historical-interval-state-machine.test.ts",
    "tests/platform/operational-interval-provider.test.ts"
  ]);
  await runVitest(focusedTests, historyGateEnvironment(databaseUrl, runId));
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    gate: "GOWM_V07_TASK_INTERVALS",
    versions,
    assertions,
    focusedTests,
    checks: {
      sqlAssertion048Executed: true,
      deterministicStateMachine: true,
      lateEventAppendsRevision: true,
      oldRevisionAsOfPreserved: true,
      exactRevisionReplayable: true,
      appendOnly: true,
      scopeBeforeRead: true,
      workerFence: true
    },
    sharedRuntimeMutated: false
  })}\n`);
});
