import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../../../packages/world-model-core/src/config.js";
import { closeDatabasePool, databasePool } from "../../../packages/runtime/src/db.js";
import { ProjectionWorker } from "./worker.js";

const config = loadConfig();
const worker = new ProjectionWorker(databasePool());
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
    if (result.claimed === 0 && result.operationalProjected === 0) await delay(config.projectionPollMs);
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await worker.close();
    await closeDatabasePool();
  });
