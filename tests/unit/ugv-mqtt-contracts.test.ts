import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe,expect,it } from "vitest";
import { decodePayload, loadSourceSchemaLock, UGV_AUTHORITY_TOPICS, validatePayload } from "../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js";
import { mapUgvMessage, worldToGnss, type MapperConfig } from "../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js";
import { SourceSchemaRegistry } from "../../packages/integrations/ugv-mqtt-ingest-core/src/source-schema-registry.js";
import { CanonicalObservationInputSchema } from "../../packages/world-model-core/src/schema.js";
import { OperationalEventIngestSchema } from "../../packages/operational-model/src/events.js";

const config: MapperConfig = { deviceId: "ugv",dataScopeKey: "airport-sim-ugv-01",sourceKey: "ugv-airport-sim-mqtt",
  producerPipelineKey: "ugv-airport-sim-mqtt:canonical-v1",scenarioId: "airport",worldEpoch: "airport-run-001",
  trackerSessionKey: "airport-run-001:ugv",analysisSpaceKey: "airport-utm48n",analysisSrid: 32648,
  arrivalUncertaintyMs: 1000,mapperVersion: "ugv-mqtt-canonical-v1" };
const base = { messageId: "00000000-0000-4000-8000-000000000001",payloadSha256: "a".repeat(64),
  adapterReceivedAt: "2026-09-04T00:00:00.000Z",retained: false,cursor: {} };

describe("UGV MQTT seven authority stream contracts",() => {
  it("contains exactly the seven fixed topics",() => {
    expect(UGV_AUTHORITY_TOPICS).toEqual(["/ugv/gnss","/ugv/speed","status/ugv","/ugv/mission_state",
      "/ugv/area_recon/status","/ugv/area_recon/targets","/ugv/area_recon/exception"]);
  });

  it("decodes String(JSON) exactly one inner level",() => {
    const value = decodePayload("/ugv/area_recon/status",Buffer.from(JSON.stringify({ data: JSON.stringify({ status: 5,status_label: "运行中" }) })));
    expect(value).toEqual({ status: 5,status_label: "运行中" });
    expect(() => decodePayload("/ugv/area_recon/status",Buffer.from(JSON.stringify({ data: JSON.stringify({ data: "{bad}" }) })))).not.toThrow();
  });

  it("validates finite values and isolated mission/recon enums",() => {
    expect(validatePayload("/ugv/mission_state",{ id: 7,type: 2,state: 4,progress: 100 }).success).toBe(true);
    expect(validatePayload("/ugv/mission_state",{ id: 7,type: 2,state: 99,progress: 0 }).success).toBe(false);
    expect(validatePayload("/ugv/area_recon/status",{ status: 4,status_label: "启动中" }).success).toBe(true);
    expect(validatePayload("/ugv/gnss",{ latitude: Number.NaN,longitude: 106.8,altitude: 500 }).success).toBe(false);
  });

  it("locks all generated source contracts and transitive local JSON Schemas",async () => {
    const root = await mkdtemp(join(tmpdir(),"ugv-source-schema-"));
    try {
      const object = (properties: Record<string,unknown>,required: string[] = []) => ({ type: "object",properties,required,additionalProperties: true });
      const topics = {
        "/{id}/gnss": object({ latitude: { type: "number" },longitude: { type: "number" },altitude: { type: "number" } },["latitude","longitude","altitude"]),
        "/{id}/speed": object({ data: { $ref: "common.json#/$defs/finiteNumber" } },["data"]),
        "status/{id}": object({ available: { type: "boolean" } }),
        "/{id}/mission_state": object({ id: { type: "integer" },type: { type: "integer" },state: { type: "integer" },progress: { type: "number" } },["state"]),
        "/{id}/area_recon/status": object({ status: { type: "integer" },status_label: { type: "string" } },["status","status_label"]),
        "/{id}/area_recon/targets": object({ targets: { type: "array" } },["targets"]),
        "/{id}/area_recon/exception": object({ kind: { type: "string" },level: { type: "integer" },error_code: { type: "integer" } },["kind","level","error_code"])
      };
      await writeFile(join(root,"mqtt_topics.json"),JSON.stringify(topics));
      await writeFile(join(root,"common.json"),JSON.stringify({ $defs: { finiteNumber: { type: "number" } } }));
      await writeFile(join(root,"mcp_ugv.json"),JSON.stringify({ ugv_area_recon_get_status: {
        description: "status",input: { type: "object" },output: { type: "object" }
      } }));
      await writeFile(join(root,"error_codes.json"),JSON.stringify({ mcp_error_codes: { "0": { name: "OK" } },
        mqtt_exception_codes: { "0x0001": "equipment","0x0006": "object loss","0x0010": "motion" } }));
      const lock = await loadSourceSchemaLock(root);
      expect(lock.files.map((file) => file.name)).toEqual(["common.json","error_codes.json","mcp_ugv.json","mqtt_topics.json"]);
      expect(lock.validatedTopics).toEqual(UGV_AUTHORITY_TOPICS);
      const registry = new SourceSchemaRegistry(lock);
      expect(registry.validate("/ugv/speed",{ data: 36 }).success).toBe(true);
      expect(registry.validate("/ugv/speed",36).success).toBe(false);
    } finally {
      await rm(root,{ recursive: true,force: true });
    }
  });

  it("maps all seven streams to separate canonical authorities",() => {
    const cases = [
      ["/ugv/gnss",{ latitude: 29.7195,longitude: 106.81485,altitude: 500 }],
      ["/ugv/speed",{ data: 36 }],
      ["status/ugv",{ ready_status: 1,veh_speed: 36,chassis_task: { state: 1 } }],
      ["/ugv/mission_state",{ id: 7,type: 2,state: 1,progress: 45 }],
      ["/ugv/area_recon/status",{ status: 5,status_label: "运行中",progress: 62,camera_fault: false }],
      ["/ugv/area_recon/targets",{ targets: [] }],
      ["/ugv/area_recon/exception",{ kind: "equipment",level: 1,error_code: 1,time_us: 1 }]
    ] as const;
    for (const [topic,payload] of cases) {
      const result = mapUgvMessage({ ...base,topic,payload },config);
      expect(result.observations).toHaveLength(1);
      for (const observation of result.observations) expect(CanonicalObservationInputSchema.safeParse(observation).success).toBe(true);
      for (const event of result.events) expect(OperationalEventIngestSchema.safeParse(event).success).toBe(true);
    }
  });

  it("uses platform as chassis observer and advances recon epochs from idle",() => {
    const chassis = mapUgvMessage({ ...base,topic: "/ugv/mission_state",payload: { id: 7,type: 2,state: 1,progress: 1 },cursor: {} },config);
    expect(chassis.observations[0]?.observer).toEqual({ type: "Device",id: "device:ugv:platform" });
    const recon = mapUgvMessage({ ...base,topic: "/ugv/area_recon/status",payload: { status: 2,status_label: "配置中" },
      cursor: { lastState: 1,reconEpoch: 1 } },config);
    expect(recon.observations[0]?.subject.id).toBe("mission:ugv:recon:airport-run-001:2");
  });

  it("bounds exception state and starts target sampling again for a new recon run",() => {
    const exception = mapUgvMessage({ ...base,topic: "/ugv/area_recon/exception",payload: {
      kind: "equipment",level: 1,error_code: 1,target_info: { reason: "r".repeat(3_000),blob: "x".repeat(70_000) }
    },cursor: {} },config);
    expect(CanonicalObservationInputSchema.safeParse(exception.observations[0]).success).toBe(true);
    expect(exception.observations[0]?.statePatch).toMatchObject({ exception: { targetInfo: { truncatedForCanonicalState: true } } });
    const target = { capture_time_us: 1,target_id: 2,type: 2,position: { longitude: 106.8,latitude: 29.7,altitude: 500 },
      velocity: { vel_e: 0,vel_n: 0,vel_u: 0 },distance: 1,confidence: 0.9,threat: 0,damage: 0,iff: 0,lock_time: 0,
      pixel_pos: { x: 0,y: 0,theta: 0,w: 1,h: 1 },role_name: "" };
    const mapped = mapUgvMessage({ ...base,topic: "/ugv/area_recon/targets",payload: { targets: [target] },
      streamContext: { reconRunIdentity: "mission:ugv:recon:airport-run-001:2" },
      cursor: { targets: { "2": { lastEmittedAt: base.adapterReceivedAt,lastAuthoritativeAttributes: { locked: false,iff: 0,threat: 0,damage: 0 },
        reconRunIdentity: "mission:ugv:recon:airport-run-001:1" } } } },config);
    expect(mapped.observations).toHaveLength(1);
    expect(mapped.observations[0]?.assertions.find((item) => item.assertionKind === "TARGET_ROLE")?.label).toBe("UNKNOWN");
  });

  it("uses sourceGeometry-only positions and skips retained GNSS",() => {
    const result = mapUgvMessage({ ...base,topic: "/ugv/gnss",payload: { latitude: 29.7195,longitude: 106.81485,altitude: 500 } },config);
    expect(result.observations[0]?.measurements[0]).not.toHaveProperty("position");
    expect(mapUgvMessage({ ...base,retained: true,topic: "/ugv/gnss",payload: { latitude: 29.7,longitude: 106.8,altitude: 0 } },config).ignoredReason)
      .toBe("RETAINED_POSITION_SKIPPED");
  });

  it("keeps chassis state 4 distinct from recon status 4 and avoids mirror events",() => {
    const chassis = mapUgvMessage({ ...base,topic: "/ugv/mission_state",payload: { id: 7,type: 2,state: 4,progress: 100 },cursor: { lastState: 1 } },config);
    const recon = mapUgvMessage({ ...base,topic: "/ugv/area_recon/status",payload: { status: 4,status_label: "启动中" },cursor: { lastState: 3 } },config);
    const mirror = mapUgvMessage({ ...base,topic: "status/ugv",payload: { chassis_task: { id: 7,state: 4 } } },config);
    expect(chassis.events[0]?.eventType).toBe("CONTROL_COMPLETED_REPORTED");
    expect(recon.events[0]?.eventType).toBe("EXECUTION_STARTED_OBSERVED");
    expect(mirror.events).toHaveLength(0);
  });

  it("marks targets observed during camera faults as candidates",() => {
    const target = { capture_time_us: 123,target_id: 142,type: 2,position: { longitude: 106.8,latitude: 29.7,altitude: 500 },
      velocity: { vel_e: 1,vel_n: 2,vel_u: 0 },distance: 85,confidence: .9,threat: 1,damage: 0,iff: 0,lock_time: 0,
      pixel_pos: { x: 1,y: 2,theta: 0,w: 10,h: 10 },role_name: "npc_tank1" };
    const result = mapUgvMessage({ ...base,topic: "/ugv/area_recon/targets",payload: { targets: [target] },streamContext: { cameraFault: true } },config);
    expect(result.observations[0]?.entityBindingStatus).toBe("CANDIDATE");
    expect(result.observations[0]?.qualityFlags).toContain("CAMERA_FAULT_ACTIVE_AT_INGEST");
  });

  it("keeps state-machine cursors deterministic across chassis and recon transitions",() => {
    const chassisStates = [0,1,2,1,4];
    const chassisEvents: string[] = [];
    let chassisCursor: Record<string,unknown> = {};
    for (const [index,state] of chassisStates.entries()) {
      const result = mapUgvMessage({ ...base,messageId: `00000000-0000-4000-8000-${String(index+10).padStart(12,"0")}`,
        adapterReceivedAt: new Date(Date.parse(base.adapterReceivedAt)+index*1_000).toISOString(),topic: "/ugv/mission_state",
        payload: { id: 7,type: 2,state,progress: index*20 },cursor: chassisCursor },config);
      chassisCursor = result.cursor;
      chassisEvents.push(...result.events.map((event) => event.eventType));
    }
    expect(chassisEvents).toEqual(["EXECUTION_STARTED_OBSERVED","EXECUTION_PAUSED_OBSERVED",
      "EXECUTION_RESUMED_OBSERVED","CONTROL_COMPLETED_REPORTED"]);

    const reconStates = [2,3,4,5,8,6,5,11];
    const reconEvents: string[] = [];
    let reconCursor: Record<string,unknown> = {};
    for (const [index,status] of reconStates.entries()) {
      const result = mapUgvMessage({ ...base,messageId: `00000000-0000-4000-8000-${String(index+30).padStart(12,"0")}`,
        adapterReceivedAt: new Date(Date.parse(base.adapterReceivedAt)+index*1_000).toISOString(),topic: "/ugv/area_recon/status",
        payload: { status,status_label: `status-${status}`,progress: index*10,coverage: index*10 },cursor: reconCursor },config);
      reconCursor = result.cursor;
      reconEvents.push(...result.events.map((event) => event.eventType));
    }
    expect(reconEvents).toEqual(["EXECUTION_STARTED_OBSERVED","EXECUTION_PAUSED_OBSERVED",
      "EXECUTION_RESUMED_OBSERVED","CONTROL_COMPLETED_REPORTED"]);
  });

  it("deduplicates command acknowledgements and treats exceptional recon states as state-only",() => {
    const ack = { seq: 19,ok: false,message: "rejected",data: { coverability: { accepted: false } } };
    const first = mapUgvMessage({ ...base,topic: "/ugv/area_recon/status",
      payload: { status: 5,status_label: "运行中",last_cmd_ack: ack },cursor: {} },config);
    expect(first.events.map((event) => event.eventType)).toEqual(["EXECUTION_STARTED_OBSERVED","CONTROL_REJECTED_OBSERVED"]);
    const replay = mapUgvMessage({ ...base,messageId: "00000000-0000-4000-8000-000000000002",
      adapterReceivedAt: "2026-09-04T00:00:01.000Z",topic: "/ugv/area_recon/status",
      payload: { status: 5,status_label: "运行中",last_cmd_ack: ack },cursor: first.cursor },config);
    expect(replay.events).toHaveLength(0);
    const unexpected = mapUgvMessage({ ...base,topic: "/ugv/area_recon/status",
      payload: { status: 13,status_label: "人工干预中" },cursor: { lastState: 5,runStarted: true } },config);
    expect(unexpected.events).toHaveLength(0);
    expect(unexpected.observations[0]?.qualityFlags).toContain("UNEXPECTED_RECON_STATUS");
  });

  it("preserves camera-fault progress as reported-only and assigns empty-frame meanings",() => {
    const fault = mapUgvMessage({ ...base,topic: "/ugv/area_recon/status",payload: {
      status: 5,status_label: "运行中",camera_fault: true,progress: 62,coverage: 61,coverage_covered: 122,coverage_total: 200
    },cursor: {} },config);
    const recon = fault.observations[0]?.statePatch?.recon as Record<string,unknown>;
    expect(recon).not.toHaveProperty("progressPercent");
    expect(recon).toMatchObject({ reportedFrozenProgress: { progressPercent: 62,coveragePercent: 61 } });
    const duringFault = mapUgvMessage({ ...base,topic: "/ugv/area_recon/targets",payload: { targets: [] },
      ...(fault.streamContext ? { streamContext: fault.streamContext } : {}),cursor: {} },config);
    expect(duringFault.observations[0]?.statePatch).toMatchObject({ reconFrame: { frameMeaning: "UNOBSERVABLE_DURING_CAMERA_FAULT" } });
    const cacheClear = mapUgvMessage({ ...base,topic: "/ugv/area_recon/targets",payload: { targets: [] },
      streamContext: { cameraFault: false,lastReconStatus: 8,reconRunIdentity: "mission:ugv:recon:airport-run-001:1" },cursor: {} },config);
    expect(cacheClear.observations[0]?.statePatch).toMatchObject({ reconFrame: { frameMeaning: "CACHE_CLEAR_FRAME" } });
  });

  it("matches the fixed local-world georeference and closes valid regions",() => {
    expect(worldToGnss(0,0,0)).toEqual([106.81485,29.7195,500]);
    const golden = worldToGnss(111.32,110.54,10);
    expect(golden[0]).toBeCloseTo(106.81585,10);
    expect(golden[1]).toBeCloseTo(29.7205,10);
    expect(golden[2]).toBe(510);
    const result = mapUgvMessage({ ...base,topic: "/ugv/area_recon/status",payload: {
      status: 3,status_label: "就绪",region: { type: 5,points: [[0,0],[111.32,0],[111.32,110.54]] }
    },cursor: {} },config);
    const region = (result.observations[0]?.statePatch?.recon as Record<string,unknown>).region as Record<string,unknown>;
    const coordinates = ((region.wgs84Geometry as Record<string,unknown>).coordinates as number[][][])[0]!;
    expect(coordinates[0]).toEqual(coordinates.at(-1));
    expect(coordinates).toHaveLength(4);
  });

  it("rejects a target frame over the configured fan-out limit as a whole",() => {
    const target = { capture_time_us: 123,target_id: 1,type: 2,position: { longitude: 106.8,latitude: 29.7,altitude: 500 },
      velocity: { vel_e: 0,vel_n: 0,vel_u: 0 },distance: 1,confidence: .9,threat: 1,damage: 0,iff: 0,lock_time: 0,
      pixel_pos: { x: 1,y: 2,theta: 0,w: 10,h: 10 },role_name: "target" };
    expect(() => mapUgvMessage({ ...base,topic: "/ugv/area_recon/targets",payload: { targets: [target,{ ...target,target_id: 2 }] } },
      { ...config,maxTargetsPerFrame: 1 })).toThrow("target frame exceeds configured maximum");
  });
});
