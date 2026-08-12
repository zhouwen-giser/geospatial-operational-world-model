import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { latLngToCell } from "h3-js";
import { MemoryWorldModel, makeObservation } from "../../packages/runtime/src/memory-world.js";
import { generatePositionObservations } from "../../simulator/src/generator.js";

interface TimingSummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

const objectSizes = parseSizes(process.env.BENCH_OBJECT_SIZES, [1_000, 10_000, 100_000, 1_000_000]);
const observationSizes = parseSizes(process.env.BENCH_OBSERVATION_SIZES, [100, 1_000, 10_000]);
const movingObjectSizes = parseSizes(process.env.BENCH_MOVING_SIZES, [10, 100, 1_000, 10_000]);

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const cpuStart = process.cpuUsage();
  const spatial = [];
  for (const size of objectSizes) {
    process.stdout.write(`spatial benchmark ${size}\n`);
    spatial.push(benchmarkSpatial(size));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }

  const observations = [];
  for (const size of observationSizes) {
    process.stdout.write(`observation benchmark ${size}\n`);
    observations.push(benchmarkObservations(size));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }

  const trajectory = [];
  for (const size of movingObjectSizes) {
    process.stdout.write(`trajectory benchmark ${size}\n`);
    trajectory.push(benchmarkMovingObjects(size));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }

  const cpu = process.cpuUsage(cpuStart);
  const report = {
    benchmarkVersion: "1.1",
    startedAt,
    completedAt: new Date().toISOString(),
    mode: "in-process-domain-and-H3",
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      cpuModel: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      finalRssBytes: process.memoryUsage().rss,
      cpuUserMs: cpu.user / 1_000,
      cpuSystemMs: cpu.system / 1_000,
      dockerAvailable: false,
      limitation: "Execution container has no Docker daemon or psql; PostGIS/h3-pg/MQTT benchmark must be rerun with npm run acceptance on a Docker host."
    },
    spatial,
    observations,
    trajectory,
    interpretation: {
      measured: "All values in this file were measured during this run; no theoretical numbers are mixed in.",
      scope: "Spatial results are a conservative O(N) in-process baseline, not indexed PostGIS results.",
      migrationTriggers: {
        clickHouse: "Run the supplied Docker benchmark first; consider ClickHouse only after sustained trajectory ingest exceeds measured PostgreSQL headroom or retention/index size breaches the agreed SLO.",
        kafka: "Keep MQTT for live delivery and PostgreSQL for replay until sustained accepted ingress exceeds 50,000 events/s for 30 minutes or a cross-region partitioned event log becomes mandatory; validate the threshold on production-sized hardware."
      }
    }
  };
  const directory = resolve(process.cwd(), "output/benchmarks");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(directory, "benchmark.md"), renderMarkdown(report));
  process.stdout.write(`${JSON.stringify({ output: "output/benchmarks/benchmark.json", spatialRuns: spatial.length, observationRuns: observations.length, trajectoryRuns: trajectory.length })}\n`);
}

function benchmarkSpatial(size: number) {
  const rssBefore = process.memoryUsage().rss;
  const longitudes = new Float64Array(size);
  const latitudes = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    longitudes[index] = 116.3 + pseudo(index * 2 + 1) * 0.2;
    latitudes[index] = 39.8 + pseudo(index * 2 + 2) * 0.2;
  }
  const repeats = size >= 1_000_000 ? 7 : 15;
  const nearbyTimes: number[] = [];
  const withinTimes: number[] = [];
  const nearestTimes: number[] = [];
  let nearbyCount = 0;
  let withinCount = 0;
  let nearestDistanceM = 0;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const targetLon = 116.39 + repeat * 0.0001;
    const targetLat = 39.89 + repeat * 0.0001;
    let start = performance.now();
    nearbyCount = scanNearby(longitudes, latitudes, targetLon, targetLat, 5_000);
    nearbyTimes.push(performance.now() - start);
    start = performance.now();
    withinCount = scanWithin(longitudes, latitudes, 116.36, 39.86, 116.44, 39.94);
    withinTimes.push(performance.now() - start);
    start = performance.now();
    nearestDistanceM = scanNearest(longitudes, latitudes, targetLon, targetLat);
    nearestTimes.push(performance.now() - start);
  }

  const h3Start = performance.now();
  const h3Counts = new Map<string, number>();
  for (let index = 0; index < size; index += 1) {
    const cell = latLngToCell(latitudes[index]!, longitudes[index]!, 9);
    h3Counts.set(cell, (h3Counts.get(cell) ?? 0) + 1);
  }
  const h3AggregationMs = performance.now() - h3Start;
  return {
    objectCount: size,
    nearby: { ...summarize(nearbyTimes), resultCount: nearbyCount },
    withinPolygon: { ...summarize(withinTimes), resultCount: withinCount },
    nearest: { ...summarize(nearestTimes), nearestDistanceM: round(nearestDistanceM) },
    h3Aggregation: { resolution: 9, elapsedMs: round(h3AggregationMs), cells: h3Counts.size, objectsPerSecond: round(size / (h3AggregationMs / 1_000)) },
    rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
    estimatedStorageBytes: size * 192
  };
}

function benchmarkObservations(size: number) {
  const timestamp = Date.parse("2026-08-11T00:00:00.000Z");
  const model = new MemoryWorldModel({ now: () => timestamp + 10_000 });
  const latencies: number[] = [];
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  for (let index = 0; index < size; index += 1) {
    const observedAt = new Date(timestamp + (index % 10_000)).toISOString();
    const observation = makeObservation({
      observationId: `bench-observation-${index}`,
      observer: { type: "Camera", id: `camera-${index % 100}` },
      subject: { type: "Vehicle", id: `vehicle-${index}` },
      observationType: "position",
      geometry: { type: "Point", coordinates: [116.39 + (index % 100) * 0.0001, 39.89 + (index % 80) * 0.0001] },
      value: { status: "MOVING", speed: index % 20 },
      confidence: 0.95,
      observedAt,
      receivedAt: new Date(Date.parse(observedAt) + 5).toISOString(),
      source: "camera"
    });
    const start = performance.now();
    model.publishObservation(observation);
    latencies.push(performance.now() - start);
  }
  const elapsedMs = performance.now() - started;
  return {
    observationCount: size,
    elapsedMs: round(elapsedMs),
    ingestRatePerSecond: round(size / (elapsedMs / 1_000)),
    projectionLatency: summarize(latencies),
    rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
    stats: model.stats()
  };
}

function benchmarkMovingObjects(size: number) {
  const timestamp = Date.parse("2026-08-11T01:00:00.000Z");
  const model = new MemoryWorldModel({ now: () => timestamp + 2_000 });
  const observations = generatePositionObservations({ vehicleCount: size, tick: 0, startTimeMs: timestamp });
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  for (const observation of observations) model.publishObservation(observation);
  const elapsedMs = performance.now() - started;
  const queryTimes: number[] = [];
  for (let index = 0; index < Math.min(100, size); index += 1) {
    const id = index === 2 ? "ugv-003" : `vehicle-sim-${String(index + 1).padStart(5, "0")}`;
    const start = performance.now();
    model.getObject(id);
    queryTimes.push(performance.now() - start);
  }
  return {
    movingObjectCount: size,
    positionIngestElapsedMs: round(elapsedMs),
    positionIngestRatePerSecond: round(size / (elapsedMs / 1_000)),
    currentPositionQuery: summarize(queryTimes),
    rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
    trajectoryPoints: model.stats().trajectoryPoints
  };
}

function scanNearby(lons: Float64Array, lats: Float64Array, lon: number, lat: number, radiusM: number): number {
  let count = 0;
  const latScale = 111_320;
  const lonScale = latScale * Math.cos((lat * Math.PI) / 180);
  const radiusSquared = radiusM * radiusM;
  for (let index = 0; index < lons.length; index += 1) {
    const dx = (lons[index]! - lon) * lonScale;
    const dy = (lats[index]! - lat) * latScale;
    if (dx * dx + dy * dy <= radiusSquared) count += 1;
  }
  return count;
}

function scanWithin(lons: Float64Array, lats: Float64Array, minLon: number, minLat: number, maxLon: number, maxLat: number): number {
  let count = 0;
  for (let index = 0; index < lons.length; index += 1) {
    if (lons[index]! >= minLon && lons[index]! <= maxLon && lats[index]! >= minLat && lats[index]! <= maxLat) count += 1;
  }
  return count;
}

function scanNearest(lons: Float64Array, lats: Float64Array, lon: number, lat: number): number {
  let best = Number.POSITIVE_INFINITY;
  const latScale = 111_320;
  const lonScale = latScale * Math.cos((lat * Math.PI) / 180);
  for (let index = 0; index < lons.length; index += 1) {
    const distance = Math.hypot((lons[index]! - lon) * lonScale, (lats[index]! - lat) * latScale);
    if (distance < best) best = distance;
  }
  return best;
}

function summarize(values: number[]): TimingSummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

function percentile(sorted: number[], value: number): number {
  if (!sorted.length) return 0;
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0);
}

function pseudo(value: number): number {
  const x = Math.sin(value * 12.9898) * 43_758.5453;
  return x - Math.floor(x);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseSizes(raw: string | undefined, fallback: number[]): number[] {
  return raw ? raw.split(",").map(Number).filter((value) => Number.isFinite(value) && value > 0) : fallback;
}

function renderMarkdown(report: {
  startedAt: string;
  completedAt: string;
  spatial: Array<ReturnType<typeof benchmarkSpatial>>;
  observations: Array<ReturnType<typeof benchmarkObservations>>;
  trajectory: Array<ReturnType<typeof benchmarkMovingObjects>>;
}): string {
  const lines = [
    "# GOWM PoC measured benchmark",
    "",
    `Run: ${report.startedAt} — ${report.completedAt}`,
    "",
    "> Scope: in-process domain/H3 benchmark. It is real measured data, but not a substitute for the supplied PostGIS/h3-pg/MQTT Docker benchmark.",
    "",
    "## Spatial core",
    "",
    "| Objects | Nearby p95 ms | Within p95 ms | Nearest p95 ms | H3 aggregate ms | RSS delta MiB |",
    "|---:|---:|---:|---:|---:|---:|",
    ...report.spatial.map((row) => `| ${row.objectCount} | ${row.nearby.p95Ms} | ${row.withinPolygon.p95Ms} | ${row.nearest.p95Ms} | ${row.h3Aggregation.elapsedMs} | ${(row.rssDeltaBytes / 1048576).toFixed(1)} |`),
    "",
    "## Observation projection",
    "",
    "| Observations | Rate/s | Projection p95 ms | RSS delta MiB |",
    "|---:|---:|---:|---:|",
    ...report.observations.map((row) => `| ${row.observationCount} | ${row.ingestRatePerSecond} | ${row.projectionLatency.p95Ms} | ${(row.rssDeltaBytes / 1048576).toFixed(1)} |`),
    "",
    "## Moving objects",
    "",
    "| Moving objects | Position rate/s | Current query p95 ms | RSS delta MiB |",
    "|---:|---:|---:|---:|",
    ...report.trajectory.map((row) => `| ${row.movingObjectCount} | ${row.positionIngestRatePerSecond} | ${row.currentPositionQuery.p95Ms} | ${(row.rssDeltaBytes / 1048576).toFixed(1)} |`),
    ""
  ];
  return lines.join("\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
