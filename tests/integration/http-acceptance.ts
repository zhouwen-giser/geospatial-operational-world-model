import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const worldUrl = process.env.WORLD_API_URL ?? "http://localhost:3000";
const ingestUrl = process.env.OBSERVATION_API_URL ?? "http://localhost:3002";
const mcpUrl = process.env.MCP_URL ?? "http://localhost:3001/mcp";

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const checks: Array<{ gate: string; check: string; ok: boolean; evidence?: unknown }> = [];
  await check(checks, "G1", "world-api health", () => json(`${worldUrl}/health`));
  await check(checks, "G1", "observation-ingest health", () => json(`${ingestUrl}/health`));
  await check(checks, "G1", "mcp health", () => json(mcpUrl.replace(/\/mcp$/, "/health")));

  const suffix = randomUUID().slice(0, 8);
  const facilityId = `acceptance-facility-${suffix}`;
  await check(checks, "G2", "create/update/get/find/relation", async () => {
    const created = await json(`${worldUrl}/world/objects`, { method: "POST", body: {
      id: facilityId, type: "Facility",
      geometry: { type: "Point", coordinates: [116.401, 39.901] },
      state: { status: "TESTING" }, properties: { acceptance: true }, confidence: 1
    } }) as Record<string, unknown>;
    const patched = await json(`${worldUrl}/world/objects/${facilityId}`, { method: "PATCH", body: {
      state: { status: "OPERATIONAL" }, expectedVersion: created.version
    } }) as Record<string, unknown>;
    const found = await json(`${worldUrl}/world/objects/search`, { method: "POST", body: {
      objectTypes: ["Facility"], filter: { acceptance: true }, limit: 10
    } }) as Record<string, unknown>;
    await json(`${worldUrl}/world/relations`, { method: "POST", body: {
      relationType: "belongsTo", fromObjectId: facilityId, toObjectId: "AOI-7", persisted: true, properties: { acceptance: true }
    } });
    const relations = await json(`${worldUrl}/world/objects/${facilityId}/relations`) as Array<Record<string, unknown>>;
    if ((patched.state as Record<string, unknown>).status !== "OPERATIONAL") throw new Error("patch not visible");
    if (Number((found.summary as Record<string, unknown>).count) < 1) throw new Error("search did not find object");
    if (!relations.some((entry) => entry.relationType === "belongsTo")) throw new Error("relation missing");
    return { objectId: facilityId, createdVersion: created.version, patchedVersion: patched.version, relationCount: relations.length };
  });

  await check(checks, "G2/G3", "nearby available UGV", async () => {
    const result = await json(`${worldUrl}/spatial/nearby`, { method: "POST", body: {
      location: { lon: 116.405, lat: 39.902 }, objectTypes: ["UGV"], radiusM: 5_000,
      filter: { status: "AVAILABLE" }, limit: 5
    } }) as Record<string, unknown>;
    if (Number((result.summary as Record<string, unknown>).count) < 1) throw new Error("no nearby UGV");
    return result.summary;
  });

  const acceptanceArea = { type: "Polygon", coordinates: [[
    [116.390, 39.890], [116.415, 39.890], [116.415, 39.915],
    [116.390, 39.915], [116.390, 39.890]
  ]] };
  await check(checks, "G3", "nearest/within/intersection", async () => {
    const nearest = await json(`${worldUrl}/spatial/nearest`, { method: "POST", body: {
      location: { lon: 116.401, lat: 39.901 }, objectTypes: ["Facility"], limit: 3
    } }) as Record<string, unknown>;
    const within = await json(`${worldUrl}/spatial/in-area`, { method: "POST", body: {
      area: acceptanceArea, objectTypes: ["Facility"], limit: 100
    } }) as Record<string, unknown>;
    const intersections = await json(`${worldUrl}/spatial/intersections`, { method: "POST", body: {
      geometry: acceptanceArea, objectTypes: ["Facility"], limit: 100
    } }) as Record<string, unknown>;
    if (Number((nearest.summary as Record<string, unknown>).count) < 1) throw new Error("nearest empty");
    if (Number((within.summary as Record<string, unknown>).count) < 1) throw new Error("within empty");
    if (Number((intersections.summary as Record<string, unknown>).count) < 1) throw new Error("intersections empty");
    return { nearest: nearest.summary, within: within.summary, intersections: intersections.summary };
  });

  const ugvId = `acceptance-ugv-${suffix}`;
  const base = Date.now() - 2_000;
  await publishPosition(ugvId, `acceptance-out-${suffix}`, 116.380, 39.900, base);
  await waitForObject(ugvId, `acceptance-out-${suffix}`);
  const liveEvent = waitForSseEvent(`${worldUrl}/events/stream?objectType=UGV&eventType=ObjectEnteredArea&areaId=AOI-1`, ugvId);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const eventStarted = performance.now();
  await publishPosition(ugvId, `acceptance-in-${suffix}`, 116.400, 39.900, base + 1_000);
  const projected = await waitForObject(ugvId, `acceptance-in-${suffix}`);
  const receivedEvent = await liveEvent;
  const eventLatencyMs = Number((performance.now() - eventStarted).toFixed(2));
  checks.push({ gate: "G5", check: "Observation → projection → World State", ok: true,
    evidence: { id: ugvId, version: projected.version, provenance: projected.provenance } });

  await check(checks, "G6", "current + historical trajectory", async () => {
    const current = await json(`${worldUrl}/trajectory/${ugvId}/current`) as Record<string, unknown>;
    const track = await json(`${worldUrl}/trajectory/${ugvId}/track`) as Record<string, unknown>;
    if (Number((track.summary as Record<string, unknown>).pointCount) < 2) throw new Error("track has fewer than two points");
    return { currentObservationId: current.observationId, summary: track.summary };
  });

  await check(checks, "G6-v1.2", "canonical evidence + MobilityDB UNKNOWN gap", async () => {
    const source = `acceptance-camera-${suffix}`;
    const targetId = `acceptance-target-${suffix}`;
    const trackerSession = `acceptance-session-${suffix}`;
    const targetLocalId = "17";
    const start = Date.now() - 1_000;
    const first = await publishCanonicalPosition({
      suffix: `${suffix}-a`,source,targetId,targetLocalId,trackerSession,
      phenomenonTime: new Date(start).toISOString(),x: 448252,y: 4417768,continuityToken: `${trackerSession}:17:a`
    });
    await publishCanonicalPosition({
      suffix: `${suffix}-b`,source,targetId,targetLocalId,trackerSession,
      phenomenonTime: new Date(start+1_000).toISOString(),x: 448253,y: 4417768,continuityToken: `${trackerSession}:17:a`
    });
    await publishCanonicalPosition({
      suffix: `${suffix}-c`,source,targetId,targetLocalId,trackerSession,
      phenomenonTime: new Date(start+5_000).toISOString(),x: 448260,y: 4417768,continuityToken: `${trackerSession}:17:b`
    });
    const canonical = await json(`${ingestUrl}/observations/${encodeURIComponent(String(first.observationId))}/canonical`) as Record<string,unknown>;
    const mobility = await waitForMobility(targetId, source);
    if (canonical.canonicalEvidenceContractVersion !== "1.2") throw new Error("canonical evidence contract missing");
    if (Number(mobility.sequenceCount) !== 2) throw new Error(`expected two sequences, got ${mobility.sequenceCount}`);
    const gaps = mobility.gaps as Array<Record<string,unknown>>;
    if (gaps.length !== 1 || gaps[0]?.bounds !== "()") throw new Error("UNKNOWN gap must be one open interval");
    return { observationId: first.observationId,trackletVersionId: mobility.trackletVersionId,
      sequenceCount: mobility.sequenceCount,gaps };
  });

  await check(checks, "G7", "ObjectEnteredArea(AOI-1)", async () => {
    const events = await json(`${worldUrl}/events?eventType=ObjectEnteredArea&subjectId=${ugvId}`) as Array<Record<string, unknown>>;
    const found = events.find((event) => (event.payload as Record<string, unknown>).areaId === "AOI-1");
    if (!found) throw new Error("AOI-1 entry event missing");
    if (receivedEvent.eventType !== "ObjectEnteredArea") throw new Error("SSE did not receive entry event");
    return { eventId: found.eventId, worldVersion: found.worldVersion, eventLatencyMs, transport: "SSE database replay + MQTT QoS 1 live topic" };
  });

  await check(checks, "G4", "point/polygon H3 + hotspot + multi-resolution", async () => {
    const area = await json(`${worldUrl}/situation/area`, { method: "POST", body: {
      area: acceptanceArea, resolution: 9
    } }) as Record<string, unknown>;
    const result = await json(`${worldUrl}/situation/hotspots`, { method: "POST", body: {
      resolution: 9, metric: "activity", limit: 10
    } }) as Record<string, unknown>;
    const facts = result.facts as Array<Record<string, unknown>>;
    if (!facts.length) throw new Error("no H3 cells");
    if (Number((area.summary as Record<string, unknown>).cellCount) < 1) throw new Error("polygon produced no H3 cells");
    const index = String(facts[0]?.h3Index);
    const hierarchy = await json(`${worldUrl}/situation/cells/${index}/hierarchy?resolution=7`);
    return { areaCells: (area.summary as Record<string, unknown>).cellCount, hotspotCount: facts.length, hierarchy };
  });

  await check(checks, "G8", "MCP Agent tools", async () => {
    const client = new Client({ name: "gowm-acceptance", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    try {
      await client.connect(transport as unknown as Transport);
      const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
      for (const required of ["find_nearby_objects", "get_area_situation", "get_object_track", "get_h3_hotspots"]) {
        if (!toolNames.includes(required)) throw new Error(`missing MCP tool ${required}`);
      }
      const calls = [
        { name: "find_nearby_objects", arguments: { location: { lon: 116.405, lat: 39.902 }, objectTypes: ["UGV"], radiusM: 5_000, limit: 5 } },
        { name: "get_area_situation", arguments: { area: acceptanceArea, resolution: 9 } },
        { name: "get_object_track", arguments: { objectId: ugvId, limit: 100 } },
        { name: "get_h3_hotspots", arguments: { resolution: 9, metric: "activity", limit: 5 } }
      ];
      for (const call of calls) {
        const result = await client.callTool(call);
        if (result.isError) throw new Error(`MCP ${call.name} returned error`);
      }
      return { exposedTools: toolNames, called: calls.map((entry) => entry.name) };
    } finally {
      await client.close();
    }
  });

  const report = { startedAt, finishedAt: new Date().toISOString(), passed: checks.every((entry) => entry.ok), checks };
  await mkdir("output/acceptance", { recursive: true });
  await writeFile("output/acceptance/docker-acceptance.json", `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

async function publishPosition(subjectId: string, observationId: string, lon: number, lat: number, time: number): Promise<void> {
  await json(`${ingestUrl}/observations`, { method: "POST", body: {
    observationId, observer: { type: "Agent", id: "acceptance-agent" },
    subject: { type: "UGV", id: subjectId }, observationType: "position",
    geometry: { type: "Point", coordinates: [lon, lat] },
    value: { status: "AVAILABLE", speed: 4.2 }, confidence: 0.99,
    observedAt: new Date(time).toISOString(), receivedAt: new Date(time + 10).toISOString(),
    source: "operator", correlationId: `acceptance-${subjectId}`, metadata: {}, schemaVersion: "1.0"
  } });
}

async function publishCanonicalPosition(input: {
  suffix: string; source: string; targetId: string; targetLocalId: string; trackerSession: string;
  phenomenonTime: string; x: number; y: number; continuityToken: string;
}): Promise<Record<string,unknown>> {
  const end = new Date(Date.parse(input.phenomenonTime)+1).toISOString();
  return json(`${ingestUrl}/observations`, { method: "POST",body: {
    schemaVersion: "1.2",observationId: `${input.source}:${input.suffix}`,
    dataScopeKey: "acceptance-v12",sourceRecordKey: input.suffix,sourceRevisionNo: 1,
    originKind: "PHYSICAL_SENSOR",observer: { type: "Camera",id: input.source },
    subject: { type: "ObservedTarget",id: input.targetId },sourceLocalTargetId: input.targetLocalId,
    trackerSessionId: input.trackerSession,observationType: "position",source: input.source,
    datastreamKey: `${input.source}:detections`,producerPipelineKey: `${input.source}:detector-v1`,
    rawReference: `inline://acceptance/${input.suffix}`,qualityFlags: [],metadata: { acceptance: true },
    timeSolution: { phenomenonTimeEstimate: input.phenomenonTime,
      phenomenonTimeWindow: { start: input.phenomenonTime,end },uncertaintySeconds: 0.02,
      correctionMethod: "ACCEPTANCE_CLOCK_MODEL",clockModelVersion: "acceptance-clock-v1" },
    measurements: [{ measurementKey: "position",measurementStage: "NORMALIZED",
      observedProperty: "position",resultKind: "POSITION",analysisSpaceKey: "default",
      position: { x: input.x,y: input.y,srid: Number(process.env.ANALYSIS_SRID ?? 32650) },
      sourceGeometry: { type: "Point",coordinates: [116.4+(input.x-448252)/100000,39.9] },
      uncertainty: { model: "HARD_RADIUS",unit: "m",horizontalValue: 5,confidenceLevel: 0.95 },
      measurementModel: "ACCEPTANCE_POSITION",measurementModelVersion: "1.0",
      algorithmConfidence: 0.87,qualityScore: 0.9,qualityFlags: [],
      continuityToken: input.continuityToken,manualCutBefore: false,attributes: {} }],
    assertions: [],entityBindingStatus: "DECLARED"
  } }) as Promise<Record<string,unknown>>;
}

async function waitForObject(id: string, observationId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${worldUrl}/world/objects/${id}`);
    if (response.ok) {
      const object = await response.json() as Record<string, unknown>;
      if ((object.provenance as Record<string, unknown> | undefined)?.sourceObservationId === observationId) return object;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`projection timeout for ${observationId}`);
}

async function waitForMobility(targetId: string, source: string): Promise<Record<string, unknown>> {
  const url = `${worldUrl}/trajectory/${encodeURIComponent(targetId)}/mobility?source=${encodeURIComponent(source)}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    const text = await response.text();
    if (response.ok) return JSON.parse(text) as Record<string, unknown>;
    if (response.status !== 404) throw new Error(`${response.status} ${url}: ${text}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`mobility projection timeout for ${targetId} from ${source}`);
}

async function waitForSseEvent(url: string, subjectId: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if ((event.subject as Record<string, unknown> | undefined)?.id === subjectId) {
          controller.abort();
          return event;
        }
      }
    }
    throw new Error("SSE closed before matching event");
  } finally {
    clearTimeout(timeout);
  }
}

async function check(
  checks: Array<{ gate: string; check: string; ok: boolean; evidence?: unknown }>,
  gate: string,
  name: string,
  action: () => Promise<unknown>
): Promise<void> {
  try { checks.push({ gate, check: name, ok: true, evidence: await action() }); }
  catch (error) { checks.push({ gate, check: name, ok: false, evidence: error instanceof Error ? error.message : String(error) }); }
}

async function json(url: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) })
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${url}: ${text}`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
