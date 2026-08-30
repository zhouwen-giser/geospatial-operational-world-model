import {
  runVitest,
  withMigratedV07Database
} from "./gowm-v07-postgres-harness.js";

await runVitest(["tests/platform/effective-snapshot-runtime.test.ts"]);

await withMigratedV07Database("effective_snapshot", async (databaseUrl, safeVersions, runId) => {
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    GOWM_V07_DATABASE_URL: databaseUrl,
    RUN_GOWM_V07_DB_INTEGRATION: "1",
    GOWM_V07_RUN_ID: runId
  };
  await runVitest(
    ["tests/integration/effective-snapshot-postgres.test.ts"],
    { ...baseEnvironment, GOWM_V07_EFFECTIVE_SNAPSHOT_PHASE: "before" }
  );
  // A second Node/Vitest process reloads the durable job and node records. This
  // prevents an in-memory Store instance from masquerading as restart proof.
  await runVitest(
    ["tests/integration/effective-snapshot-postgres.test.ts"],
    { ...baseEnvironment, GOWM_V07_EFFECTIVE_SNAPSHOT_PHASE: "after" }
  );
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    gate: "GOWM_V07_EFFECTIVE_SNAPSHOT",
    versions: safeVersions,
    checks: {
      resolverDiscoversResource: true,
      downstreamReceivesPersistedEffectiveSnapshot: true,
      strictConflictFailsClosed: true,
      bestEffortConflictIsExplicit: true,
      cas: true,
      atomicNodeAndSnapshot: true,
      constraintFailureRollback: true,
      staleFenceRejected: true,
      crossProcessReload: true
    }
  })}\n`);
});
