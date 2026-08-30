import {
  runVitest,
  withMigratedV07Database
} from "./gowm-v07-postgres-harness.js";

await withMigratedV07Database("analysis_inputs", async (databaseUrl, safeVersions, runId) => {
  await runVitest(
    ["tests/integration/analysis-resource-inputs.test.ts"],
    {
      ...process.env,
      DATABASE_URL: databaseUrl,
      GOWM_V07_DATABASE_URL: databaseUrl,
      RUN_GOWM_V07_DB_INTEGRATION: "1",
      GOWM_V07_RUN_ID: runId
    }
  );
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    gate: "GOWM_V07_ANALYSIS_RESOURCE_INPUTS",
    versions: safeVersions,
    checks: {
      controlledResourceWrite: true,
      controlledInputSetWrite: true,
      deterministicInputSetDigest: true,
      idempotentReplay: true,
      conflictRejected: true,
      crossScopeRejected: true,
      appendOnly: true,
      scopeBeforeRead: true
    }
  })}\n`);
});
