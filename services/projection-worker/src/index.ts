import { projectionConcurrency } from "./concurrency.js";
import pg from "pg";
import { loadConfig } from "../../../packages/world-model-core/src/config.js";
import { closeDatabasePool, databasePool } from "../../../packages/runtime/src/db.js";
import { createPostgresHistoricalProjectionStages } from "./historical-runtime-adapter.js";
import { loadWorkerBackoffConfig, WorkerLoopBackoff } from "./loop-backoff.js";
import { ProjectionWorker } from "./worker.js";

const config = loadConfig();
const pool = databasePool();
const concurrency=projectionConcurrency();
const historicalConnectionString = process.env.HISTORICAL_WORKER_DATABASE_URL?.trim();
if (!historicalConnectionString) {
  throw new Error("HISTORICAL_WORKER_DATABASE_URL is required for controlled historical projection writes");
}
const historicalPool = new pg.Pool({
  connectionString: historicalConnectionString,
  application_name: "gowm-historical-projection-worker",
  max: 1,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});
historicalPool.on("error", () => process.stderr.write("historical projection pool error\n"));
const shutdownController = new AbortController();
const leasePool = new pg.Pool({connectionString:historicalConnectionString,
  application_name:"gowm-historical-lease-renewal",max:2,
  connectionTimeoutMillis:1000,statement_timeout:1000,query_timeout:1500});
leasePool.on("error", () => process.stderr.write("historical lease pool error\n"));
// Frozen requests must not wait for live tracklet rebuilds or their pool.
const requestPool = new pg.Pool({connectionString:historicalConnectionString,
  application_name:"gowm-historical-request-worker",max:concurrency.history,
  idleTimeoutMillis:30_000,connectionTimeoutMillis:5_000});
requestPool.on("error", () => process.stderr.write("historical request pool error\n"));
const trackletPool=new pg.Pool({connectionString:historicalConnectionString,application_name:"gowm-tracklet-worker",
  max:concurrency.tracklet,idleTimeoutMillis:30_000,connectionTimeoutMillis:5_000});
const finalizationPool=new pg.Pool({connectionString:historicalConnectionString,application_name:"gowm-finalization-worker",
  max:concurrency.finalization,idleTimeoutMillis:30_000,connectionTimeoutMillis:5_000});
for(const p of [trackletPool,finalizationPool]) p.on("error",()=>process.stderr.write("tracklet pool error\n"));
const worker = new ProjectionWorker(pool, {
  historical: createPostgresHistoricalProjectionStages(historicalPool, {leasePool,requestPool,trackletPool,finalizationPool,signal:shutdownController.signal})
});
let running = true;

const shutdown = () => {
  running = false;
  shutdownController.abort();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function main(): Promise<void> {
  if (process.argv.includes("--once")) {
    const result = await worker.tick();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.historicalStageFailures > 0) process.exitCode = 1;
    return;
  }
  process.stdout.write("projection-worker ready\n");
  console.log(JSON.stringify({event:"projection_concurrency",...concurrency}));
  const lanes = await Promise.allSettled([
    runLane("CORE",0),
    ...Array.from({length:concurrency.tracklet},(_,slot)=>runLane("TRACKLET",slot)),
    ...Array.from({length:concurrency.finalization},(_,slot)=>runLane("FINALIZATION",slot)),
    ...Array.from({length:concurrency.history},(_,slot)=>runLane("HISTORY",slot))
  ]);
  const failed = lanes.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

async function runLane(lane: "CORE" | "TRACKLET" | "FINALIZATION" | "HISTORY", slot:number): Promise<void> {
  const backoff = new WorkerLoopBackoff(loadWorkerBackoffConfig());

  try {
    while (running) {
      const result = await worker.tick(lane);
      if (lane === "HISTORY" && result.historicalTrajectoryClaims > 0) {
        process.stdout.write(`${JSON.stringify({event:"historical_request_tick",slot,...result})}\n`);
      }
      const previousBackoffState = backoff.state;
      const decision = backoff.decide(result, config.projectionPollMs);
      if (decision.reason === "STAGE_FAILURE") {
        process.stderr.write(`${JSON.stringify({
          event: "historical_projection_backoff", lane,
          historicalStageFailures: result.historicalStageFailures,
          failedHistoricalStages: result.failedHistoricalStages,
          consecutiveStageFailures: decision.consecutiveStageFailures,
          delayMs: decision.delayMs
        })}\n`);
      }
      if (previousBackoffState.consecutiveStageFailures > 0
          && decision.consecutiveStageFailures === 0) {
        process.stdout.write(`${JSON.stringify({
          event: "historical_projection_backoff_reset", lane,
          previousConsecutiveStageFailures: previousBackoffState.consecutiveStageFailures,
          consecutiveStageFailures: decision.consecutiveStageFailures,
          reason: decision.reason,
          delayMs: decision.delayMs
        })}\n`);
      }
      try {
        await backoff.wait(decision, shutdownController.signal);
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) throw error;
      }
    }
  } catch (error) {
    shutdown();
    throw error;
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await worker.close();
    await historicalPool.end();
    await requestPool.end();
    await trackletPool.end();
    await finalizationPool.end();
    await leasePool.end();
    await closeDatabasePool();
  });
