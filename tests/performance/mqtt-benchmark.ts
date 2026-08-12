import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { WorldEventBus } from "../../packages/runtime/src/bus.js";
import type { WorldEvent } from "../../packages/world-model-core/src/types.js";

async function main(): Promise<void> {
  const messageCount = Number(process.env.MQTT_BENCH_MESSAGES ?? 1_000);
  const bus = new WorldEventBus();
  const publishedAt = new Map<string, number>();
  const latencies: number[] = [];
  let resolveReceived: (() => void) | undefined;
  const allReceived = new Promise<void>((resolve) => { resolveReceived = resolve; });
  const subscription = await bus.subscribeEvents((event) => {
    const started = publishedAt.get(event.eventId);
    if (started === undefined) return;
    latencies.push(performance.now() - started);
    publishedAt.delete(event.eventId);
    if (latencies.length === messageCount) resolveReceived?.();
  });

  const started = performance.now();
  let elapsedMs = 0;
  try {
    for (let index = 0; index < messageCount; index += 1) {
      const event: WorldEvent = {
        eventId: randomUUID(),
        eventType: "SituationUpdated",
        subject: { type: "Situation", id: `mqtt-bench-${index}` },
        timestamp: new Date().toISOString(),
        worldVersion: index + 1,
        correlationId: "mqtt-benchmark",
        causationId: `mqtt-benchmark-${index}`,
        payload: { index },
        schemaVersion: "1.0"
      };
      publishedAt.set(event.eventId, performance.now());
      await bus.publishEvent(event);
    }
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      allReceived,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("MQTT benchmark subscriber timed out")), 30_000);
      })
    ]);
    if (timeout) clearTimeout(timeout);
    elapsedMs = performance.now() - started;
  } finally {
    subscription.unsubscribe();
    await bus.drain();
  }

  const output = {
    scope: "MQTT 5 QoS 1 publish-PUBACK-subscriber loopback",
    runAt: new Date().toISOString(),
    messageCount,
    elapsedMs: round(elapsedMs),
    throughputPerSecond: round(messageCount / (elapsedMs / 1_000)),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: round(Math.max(...latencies))
    }
  };
  await mkdir("output/benchmarks", { recursive: true });
  await writeFile("output/benchmarks/mqtt-benchmark.json", `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)] ?? 0);
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
