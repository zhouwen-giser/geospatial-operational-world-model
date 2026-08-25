import pg from "pg";

import { PostgresCoverageAsyncRepository } from "../../packages/road-coverage-runtime-core/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const submission = (suffix: string, jobSuffix: string) => ({
  dataScopeKey: "coverage-async-runtime",
  datasetScopeKey: "dataset-a",
  externalRequestId: `coverage-request-${suffix}`,
  idempotencyKey: `coverage-idempotency-${suffix}`,
  gatewayJobId: `20000000-0000-0000-0000-${jobSuffix.padStart(12, "0")}`,
  requestHash: `sha256:${suffix.repeat(64).slice(0, 64)}` as `sha256:${string}`,
  routingSnapshotHash: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
  routingSnapshot: { graphVersion: "graph-v1" },
  request: { operation: "coverage.road.plan", suffix }
});

let pool = new pg.Pool({ connectionString: databaseUrl, max: 2, application_name: "coverage-async-runtime-first" });
let repository = new PostgresCoverageAsyncRepository(pool);
const first = await repository.submit(submission("1", "1"));
const second = await repository.submit(submission("2", "2"));
const replay = await repository.submit(submission("1", "1"));
let conflict = false;
try { await repository.submit({ ...submission("1", "1"), requestHash: `sha256:${"9".repeat(64)}` }); } catch (error) { conflict = (error as { code?: string }).code === "23505"; }
const claim = await repository.claimNext("worker-first", 1, 1);
if (claim === null) throw new Error("first async claim returned no job");
const admissionBlocked = await repository.claimNext("worker-blocked", 30, 1) === null;
const heartbeat = await repository.heartbeat(claim, "worker-first", 1, "SOLVING", 500_000, { cpuMs: 10 });
const regressed = await repository.heartbeat(claim, "worker-first", 1, "REGRESSED", 400_000, {});

await pool.end();
pool = new pg.Pool({ connectionString: databaseUrl, max: 2, application_name: "coverage-async-runtime-restarted" });
repository = new PostgresCoverageAsyncRepository(pool);
const survivesRestart = await repository.heartbeat(claim, "worker-first", 1, "VERIFYING", 600_000, { restart: true });
await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
const reaped = await repository.reapExpired(10);
const restarted = await repository.claimNext("worker-restarted", 30, 1);
if (restarted === null) throw new Error("requeued job was not reclaimed");
const canonicalProblem = {
  startState: { arcKey: `arc_${"1".repeat(32)}`, fractionPpm: 0, direction: "FORWARD" },
  entryStates: [],
  exitStates: [],
  obligationSet: { obligations: [{
    obligationId: "obligation-runtime-1", graphVersion: "graph-v1", edgeKey: "edge-runtime-1",
    arcKey: `arc_${"2".repeat(32)}`, startFractionPpm: 0, endFractionPpm: 1_000_000,
    requiredPasses: 1, selectionPolicyVersion: "coverage-selection/1.0", contentHash: `sha256:${"2".repeat(64)}`
  }] }
};
await repository.persistProblem(restarted, "worker-restarted", `sha256:${"b".repeat(64)}`, canonicalProblem);
const cancelled = await repository.cancel(restarted.coverageRequestId, "runtime cancellation");
const lateHeartbeat = await repository.heartbeat(restarted, "worker-restarted", 30, "LATE", 900_000, {});
let lateResultRejected = false;
try {
  await repository.publishResult(restarted, "worker-restarted", {
    referenceKey: `wrf_${"1".repeat(32)}`, status: "SUCCEEDED", resultHash: `sha256:${"c".repeat(64)}`,
    validUntil: new Date(Date.now() + 60_000).toISOString(), result: { revalidationRequired: true }
  });
} catch { lateResultRejected = true; }
const secondClaim = await repository.claimNext("worker-second", 30, 1);
const noGhostResult = await repository.getResult(restarted.coverageRequestId, "coverage-async-runtime", "dataset-a") === null;
if (secondClaim === null) throw new Error("next queued job was not preserved");
await repository.persistProblem(secondClaim, "worker-second", `sha256:${"d".repeat(64)}`, {
  ...canonicalProblem,
  obligationSet: { obligations: canonicalProblem.obligationSet.obligations.map((obligation) => ({
    ...obligation,
    obligationId: "obligation-runtime-2",
    contentHash: `sha256:${"3".repeat(64)}`
  })) }
});
const completed = await repository.publishResult(secondClaim, "worker-second", {
  referenceKey: `wrf_${"2".repeat(32)}`,
  status: "SUCCEEDED",
  resultHash: `sha256:${"e".repeat(64)}`,
  validUntil: new Date(Date.now() + 60_000).toISOString(),
  result: { revalidationRequired: true, alternatives: [{ rank: 1 }] }
});
await pool.end();
pool = new pg.Pool({ connectionString: databaseUrl, max: 2, application_name: "coverage-async-runtime-result-restarted" });
repository = new PostgresCoverageAsyncRepository(pool);
const completedResult = await repository.getResult(secondClaim.coverageRequestId, "coverage-async-runtime", "dataset-a");
const completedReplay = await repository.submit(submission("2", "2"));
const raced = await repository.submit(submission("3", "3"));
const raceClaim = await repository.claimNext("worker-race", 30, 1);
if (raceClaim === null || raceClaim.coverageRequestId !== raced.coverageRequestId) throw new Error("race fixture was not claimed");
await repository.persistProblem(raceClaim, "worker-race", `sha256:${"f".repeat(64)}`, {
  ...canonicalProblem,
  obligationSet: { obligations: canonicalProblem.obligationSet.obligations.map((obligation) => ({
    ...obligation,
    obligationId: "obligation-runtime-3",
    contentHash: `sha256:${"4".repeat(64)}`
  })) }
});
const [raceCancel, racePublish] = await Promise.allSettled([
  repository.cancel(raceClaim.coverageRequestId, "simultaneous operator cancellation"),
  repository.publishResult(raceClaim, "worker-race", {
    referenceKey: `wrf_${"3".repeat(32)}`,
    status: "SUCCEEDED",
    resultHash: `sha256:${"5".repeat(64)}`,
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    result: { revalidationRequired: true, alternatives: [{ rank: 1 }] }
  })
]);
const raceCancelWon = raceCancel.status === "fulfilled" && raceCancel.value;
const racePublishWon = racePublish.status === "fulfilled" && racePublish.value;
const raceResult = await repository.getResult(raceClaim.coverageRequestId, "coverage-async-runtime", "dataset-a");
await pool.end();

const checks = {
  idempotentReplay: replay.coverageRequestId === first.coverageRequestId && replay.replayed,
  idempotencyConflict: conflict,
  orderedClaim: claim.coverageRequestId === first.coverageRequestId && first.status === "QUEUED" && second.status === "QUEUED",
  databaseAllocatedInitialAttempt: claim.attempt === 1,
  boundedAdmission: admissionBlocked,
  heartbeatAccepted: heartbeat,
  monotonicProgress: regressed === false,
  gatewayRestartPersistence: survivesRestart,
  expiredLeaseReaped: reaped === 1,
  workerRestartGeneration: restarted.coverageRequestId === first.coverageRequestId && restarted.generation === claim.generation + 1,
  databaseAllocatedReclaimAttempt: restarted.attempt === claim.attempt + 1,
  cancelGenerationFence: cancelled && lateHeartbeat === false,
  lateResultRejected,
  noGhostResult,
  nextQueuedJobPreserved: secondClaim.coverageRequestId === second.coverageRequestId,
  completedReplayReusesJobAndResult: completed && completedReplay.coverageRequestId === second.coverageRequestId &&
    completedReplay.status === "SUCCEEDED" && completedReplay.replayed && completedResult?.revalidationRequired === true,
  simultaneousCancelPublishHasOneCoherentWinner: raceCancelWon !== racePublishWon &&
    (racePublishWon ? raceResult?.revalidationRequired === true : raceResult === null)
};
if (Object.values(checks).some((value) => !value)) throw new Error(`async runtime checks failed: ${JSON.stringify(checks)}`);
process.stdout.write(`${JSON.stringify({ status: "PASS", checks, firstRequestId: first.coverageRequestId, secondRequestId: second.coverageRequestId, firstGeneration: claim.generation, restartedGeneration: restarted.generation })}\n`);
