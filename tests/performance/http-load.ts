import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { databasePool, closeDatabasePool } from "../../packages/runtime/src/db.js";

const ingestUrl = process.env.OBSERVATION_API_URL ?? "http://localhost:3002";
const worldUrl = process.env.WORLD_API_URL ?? "http://localhost:3000";
const durationSeconds = Number(process.env.LOAD_DURATION_SECONDS ?? 1);
const targets = (process.env.LOAD_TARGET_RATES ?? "100,1000,10000")
  .split(",").map(Number).filter((value) => Number.isFinite(value) && value > 0);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 250);

async function main(): Promise<void> {
  const runId = randomUUID().slice(0, 8);
  const pool = databasePool();
  const beforeBytes = await storageBytes();
  const results = [];
  for (const target of targets) {
    const total = Math.max(1, Math.round(target * durationSeconds));
    const latencies: number[] = [];
    let accepted = 0;
    let failed = 0;
    const start = performance.now();
    const sliceCount = Math.max(1, Math.ceil(durationSeconds * 10));
    for (let slice = 0; slice < sliceCount; slice += 1) {
      const sliceStart = performance.now();
      const from = Math.floor(slice * total / sliceCount);
      const to = Math.floor((slice + 1) * total / sliceCount);
      await limited(Array.from({ length: to - from }, (_, offset) => from + offset), concurrency, async (index) => {
        const requestStart = performance.now();
        const subjectId = `load-${runId}-${target}-${index}`;
        const observedAt = new Date().toISOString();
        try {
          const response = await fetch(`${ingestUrl}/observations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              observationId: `load-obs-${runId}-${target}-${index}`,
              observer: { type: "Agent", id: "http-load-generator" },
              subject: { type: "Vehicle", id: subjectId }, observationType: "position",
              geometry: { type: "Point", coordinates: [116.35 + (index % 1000) * 0.0001, 39.85 + (index % 700) * 0.0001] },
              value: { status: "MOVING", speed: index % 30 }, confidence: 0.95,
              observedAt, receivedAt: observedAt, source: "simulator",
              correlationId: `load-${runId}-${target}`, metadata: { loadTest: true, target }, schemaVersion: "1.0"
            })
          });
          if (response.ok) accepted += 1; else failed += 1;
          await response.arrayBuffer();
        } catch {
          failed += 1;
        }
        latencies.push(performance.now() - requestStart);
      });
      const desiredSliceMs = durationSeconds * 1_000 / sliceCount;
      const remaining = desiredSliceMs - (performance.now() - sliceStart);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    const elapsedMs = performance.now() - start;
    const lastIndex = total - 1;
    const projectionWaitStart = performance.now();
    const projected = await waitForProjection(
      `load-${runId}-${target}-${lastIndex}`,
      `load-obs-${runId}-${target}-${lastIndex}`,
      30_000
    );
    results.push({
      targetEventsPerSecond: target,
      durationSeconds,
      offeredCount: total,
      accepted,
      failed,
      wallMs: round(elapsedMs),
      achievedAcceptedPerSecond: round(accepted / (elapsedMs / 1_000)),
      requestLatency: summarize(latencies),
      lastObservationProjectionWaitMs: projected ? round(performance.now() - projectionWaitStart) : null,
      targetMet: accepted === total && elapsedMs <= durationSeconds * 1_000 * 1.1
    });
  }
  const afterBytes = await storageBytes();
  const report = {
    benchmark: "HTTP Observation offered-load + projection lag",
    runAt: new Date().toISOString(),
    runId,
    concurrency,
    results,
    storage: { beforeBytes, afterBytes, growthBytes: afterBytes - beforeBytes },
    note: "targetMet means accepted count completed within 110% of the offered duration; a miss is recorded, not hidden."
  };
  await mkdir("output/benchmarks", { recursive: true });
  await writeFile("output/benchmarks/http-load.json", `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (results.every((entry) => entry.accepted === 0)) process.exitCode = 1;
  await closeDatabasePool();

  async function storageBytes(): Promise<number> {
    const result = await pool.query<{ bytes: string }>(
      `SELECT COALESCE(sum(pg_total_relation_size(oid)), 0)::text AS bytes
       FROM pg_class WHERE relname = ANY($1::text[])`,
      [["world_object", "world_object_state", "world_object_geometry", "world_observation", "world_event", "trajectory_point", "situation_cell"]]
    );
    return Number(result.rows[0]?.bytes ?? 0);
  }
}

async function waitForProjection(subjectId: string, observationId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${worldUrl}/world/objects/${subjectId}`);
    if (response.ok) {
      const object = await response.json() as Record<string, unknown>;
      if ((object.provenance as Record<string, unknown> | undefined)?.sourceObservationId === observationId) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function limited<T>(values: T[], limit: number, action: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await action(values[index]!);
    }
  }));
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, p50Ms: at(sorted, 0.50), p95Ms: at(sorted, 0.95), p99Ms: at(sorted, 0.99), maxMs: round(sorted.at(-1) ?? 0) };
}

function at(sorted: number[], p: number): number {
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0);
}

function round(value: number): number { return Math.round(value * 100) / 100; }

main().catch(async (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
  await closeDatabasePool();
});
