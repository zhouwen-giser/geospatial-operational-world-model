import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  repositoryRoot,
  withMigratedV07Database
} from "./gowm-v07-postgres-harness.js";
import { runSqlAssertionFiles } from "./gowm-v07-history-harness.js";

const assertionFile = "database/tests/051_historical_security_negative_assertions.sql";

const observationRepository = await readFile(
  resolve(repositoryRoot, "packages/runtime/src/observation-repository.ts"),
  "utf8"
);
if (!observationRepository.includes("source_record_key=$3 AND source_revision_no=$4")) {
  throw new Error("immutable source-record revision conflict lookup is missing");
}
if (!observationRepository.includes('code: "IDEMPOTENCY_CONFLICT"')) {
  throw new Error("immutable source-record conflict is not mapped to IDEMPOTENCY_CONFLICT");
}

await withMigratedV07Database("history_security", async (databaseUrl, versions) => {
  const assertions = await runSqlAssertionFiles(databaseUrl, [assertionFile]);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    gate: "GOWM_V07_HISTORY_SECURITY_NEGATIVE",
    versions,
    assertions,
    checks: {
      crossScopeTrackletRejected: true,
      crossScopeTrackletSegmentRejected: true,
      crossScopeWatermarkRejected: true,
      crossScopeSourceSelectionRejected: true,
      foreignEffectiveSnapshotRejected: true,
      crossScopeArtifactRejected: true,
      missingArtifactRejected: true,
      forgedHistoricalTrajectoryReferenceRejected: true,
      sameSourceRecordConflictRejected: true,
      sourceRecordConflictMappedToIdempotencyConflict: true,
      failClosed: true
    },
    sharedRuntimeMutated: false
  })}\n`);
});
