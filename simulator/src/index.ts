import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../../packages/world-model-core/src/config.js";
import {
  generateCameraObservations,
  generateIncidentObservations,
  generatePositionObservations,
  generateSensorObservations
} from "./generator.js";

interface Args {
  vehicleCount: number;
  rateHz: number;
  durationSeconds: number;
  continuous: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const value = (name: string, fallback: number) => {
    const arg = process.argv.find((item) => item.startsWith(`--${name}=`));
    return arg ? Number(arg.split("=")[1]) : fallback;
  };
  return {
    vehicleCount: value("vehicles", Number(process.env.SIM_VEHICLES ?? 100)),
    rateHz: value("rate", Number(process.env.SIM_RATE_HZ ?? 1)),
    durationSeconds: value("duration", 60),
    continuous: process.argv.includes("--continuous"),
    dryRun: process.argv.includes("--dry-run")
  };
}

async function publishBatch(url: string, observations: ReturnType<typeof generatePositionObservations>): Promise<{ accepted: number; failed: number }> {
  let accepted = 0;
  let failed = 0;
  const concurrency = 50;
  for (let offset = 0; offset < observations.length; offset += concurrency) {
    const chunk = observations.slice(offset, offset + concurrency);
    const results = await Promise.all(chunk.map(async (observation) => {
      const response = await fetch(`${url}/observations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(observation)
      });
      return response.ok;
    }));
    accepted += results.filter(Boolean).length;
    failed += results.filter((result) => !result).length;
  }
  return { accepted, failed };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!Number.isFinite(args.rateHz) || args.rateHz <= 0 || !Number.isInteger(args.vehicleCount) || args.vehicleCount <= 0) {
    throw new Error("--rate must be positive and --vehicles must be a positive integer");
  }
  const config = loadConfig();
  const startedAt = Date.now();
  let tick = 0;
  let accepted = 0;
  let failed = 0;
  do {
    const tickIntervalMs = 1_000 / args.rateHz;
    const positions = generatePositionObservations({ vehicleCount: args.vehicleCount, tick, startTimeMs: startedAt, tickIntervalMs });
    const sensorReadings = generateSensorObservations(tick, startedAt, 20, tickIntervalMs);
    const cameraReadings = generateCameraObservations(tick, startedAt, 4, tickIntervalMs);
    const incidents = generateIncidentObservations(tick, startedAt, tickIntervalMs);
    const observations = [...positions, ...sensorReadings, ...cameraReadings, ...incidents];
    if (args.dryRun) {
      if (tick === 0) process.stdout.write(`${JSON.stringify([
        ...positions.slice(0, 4), ...sensorReadings.slice(0, 1), ...cameraReadings.slice(0, 1), ...incidents
      ], null, 2)}\n`);
      accepted += observations.length;
    } else {
      const result = await publishBatch(config.observationApiUrl, observations);
      accepted += result.accepted;
      failed += result.failed;
    }
    tick += 1;
    if (!args.continuous && tick >= args.durationSeconds * args.rateHz) break;
    await delay(1_000 / args.rateHz);
  } while (true);
  process.stdout.write(`${JSON.stringify({ ticks: tick, accepted, failed, durationMs: Date.now() - startedAt })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
