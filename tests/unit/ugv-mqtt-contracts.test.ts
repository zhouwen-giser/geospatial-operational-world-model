import { describe,expect,it } from "vitest";
import { decodePayload, UGV_AUTHORITY_TOPICS, validatePayload } from "../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js";
import { mapUgvMessage, type MapperConfig } from "../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js";

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
      if (topic === "/ugv/area_recon/targets") expect(result.observations).toHaveLength(0);
      else expect(result.observations).toHaveLength(1);
    }
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
    const result = mapUgvMessage({ ...base,topic: "/ugv/area_recon/targets",payload: { targets: [target] },cursor: { cameraFault: true } },config);
    expect(result.observations[0]?.entityBindingStatus).toBe("CANDIDATE");
    expect(result.observations[0]?.qualityFlags).toContain("CAMERA_FAULT_ACTIVE_AT_INGEST");
  });
});
