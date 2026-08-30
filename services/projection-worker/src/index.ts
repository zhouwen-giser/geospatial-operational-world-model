import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { loadConfig } from "../../../packages/world-model-core/src/config.js";
import { closeDatabasePool, databasePool } from "../../../packages/runtime/src/db.js";
import { createPostgresHistoricalProjectionStages } from "./historical-runtime-adapter.js";
import { isIdleWorkerTick, ProjectionWorker } from "./worker.js";

const config = loadConfig();
const pool = databasePool();
const historicalConnectionString = process.env.HISTORICAL_WORKER_DATABASE_URL?.trim();
if (!historicalConnectionString) {
  throw new Error("HISTORICAL_WORKER_DATABASE_URL is required for controlled historical projection writes");
}
const historicalPool = new pg.Pool({
  connectionString: historicalConnectionString,
  application_name: "gowm-historical-projection-worker",
  max: Math.max(1, Math.min(config.projectionBatchSize, 16)),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});
historicalPool.on("error", () => process.stderr.write("historical projection pool error\n"));
const worker = new ProjectionWorker(pool, {
  historical: createPostgresHistoricalProjectionStages(historicalPool)
});
let running = true;

const shutdown = () => { running = false; };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function main(): Promise<void> {
  if (process.argv.includes("--once")) {
    const result = await worker.tick();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write("projection-worker ready\n");
  while (running) {
    const result = await worker.tick();
    if (isIdleWorkerTick(result)) await delay(config.projectionPollMs);
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
    await closeDatabasePool();
  });
