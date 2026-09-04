import { canonicalJson } from "../../../observation-model/src/canonical.js";
import type { CanonicalObservationInput } from "../../../world-model-core/src/types.js";
import type { OperationalEventIngest } from "../../../operational-model/src/events.js";
import { sha256, type UgvAuthorityTopic } from "./contracts.js";

type Json = Record<string, unknown>;
export interface MapperConfig {
  deviceId: string; dataScopeKey: string; sourceKey: string; producerPipelineKey: string;
  scenarioId: string; worldEpoch: string; trackerSessionKey: string; analysisSpaceKey: string;
  analysisSrid: number; arrivalUncertaintyMs: number; mapperVersion: string;
}
export interface MapperInput {
  messageId: string; topic: UgvAuthorityTopic; payloadSha256: string; payload: unknown;
  adapterReceivedAt: string; retained: boolean; cursor: Json;
}
export interface MappingResult {
  observations: CanonicalObservationInput[];
  events: OperationalEventIngest[];
  cursor: Json;
  ignoredReason?: string;
}

const targetTypes: Record<number,string> = { 1: "PERSON",2: "VEHICLE",3: "ARMOR",4: "BUILDING" };
const chassisEvent: Record<string,OperationalEventIngest["eventType"] | undefined> = {
  "0:1": "EXECUTION_STARTED_OBSERVED","2:1": "EXECUTION_RESUMED_OBSERVED","1:2": "EXECUTION_PAUSED_OBSERVED",
  "1:3": "EXECUTION_STOPPED_OBSERVED","1:4": "CONTROL_COMPLETED_REPORTED","1:5": "EXECUTION_FAILED_OBSERVED",
  "2:3": "EXECUTION_STOPPED_OBSERVED","2:4": "CONTROL_COMPLETED_REPORTED","2:5": "EXECUTION_FAILED_OBSERVED"
};
const reconEvent: Record<number,OperationalEventIngest["eventType"] | undefined> = {
  4: "EXECUTION_STARTED_OBSERVED",5: "EXECUTION_STARTED_OBSERVED",6: "EXECUTION_RESUMED_OBSERVED",
  8: "EXECUTION_PAUSED_OBSERVED",9: "EXECUTION_STOPPED_OBSERVED",10: "EXECUTION_FAILED_OBSERVED",11: "CONTROL_COMPLETED_REPORTED"
};

export function mapUgvMessage(input: MapperInput, config: MapperConfig): MappingResult {
  if (input.topic === "/ugv/gnss" && input.retained) return { observations: [],events: [],cursor: input.cursor,ignoredReason: "RETAINED_POSITION_SKIPPED" };
  switch (input.topic) {
    case "/ugv/gnss": return mapGnss(input,config);
    case "/ugv/speed": return mapSpeed(input,config);
    case "status/ugv": return mapPlatform(input,config);
    case "/ugv/mission_state": return mapChassisMission(input,config);
    case "/ugv/area_recon/status": return mapReconStatus(input,config);
    case "/ugv/area_recon/targets": return mapTargets(input,config);
    case "/ugv/area_recon/exception": return mapException(input,config);
  }
}

function baseObservation(input: MapperInput,config: MapperConfig,ordinal: number,subject: { type: string; id: string },
  observer: { type: string; id: string },observationType: string,datastreamKey: string,
  measurements: CanonicalObservationInput["measurements"],statePatch?: Json,extra: Partial<CanonicalObservationInput> = {}): CanonicalObservationInput {
  const sourceRecordKey = `mqtt:${config.deviceId}:${encodeURIComponent(input.topic)}:${input.messageId}:${ordinal}`;
  const withoutId = { sourceKey: config.sourceKey,inboxMessageId: input.messageId,ordinal,mapperVersion: config.mapperVersion,
    subject,observer,observationType,datastreamKey,measurements,statePatch: statePatch ?? null };
  const observationId = `ugvobs_${sha256(canonicalJson(withoutId))}`;
  const estimate = input.adapterReceivedAt;
  const end = new Date(Date.parse(estimate) + Math.max(1,config.arrivalUncertaintyMs)).toISOString();
  const rawSourceTime = sourceTimeRaw(input.payload);
  const rawSourceTicks = sourceTicks(input.payload);
  return {
    schemaVersion: "1.2",observationId,dataScopeKey: config.dataScopeKey,sourceRecordKey,sourceRevisionNo: 1,
    originKind: "SIMULATION",observer,subject,observationType,source: config.sourceKey,datastreamKey,
    producerPipelineKey: config.producerPipelineKey,rawReference: `ugv-inbox://${input.messageId}`,
    qualityFlags: ["SOURCE_EVENT_TIME_MISSING"],metadata: { mqttTopic: input.topic,payloadSha256: input.payloadSha256,
      mapperVersion: config.mapperVersion,scenarioId: config.scenarioId,worldEpoch: config.worldEpoch },
    ...(statePatch ? { statePatch } : {}),timeSolution: { phenomenonTimeEstimate: estimate,
      phenomenonTimeWindow: { start: estimate,end },uncertaintySeconds: config.arrivalUncertaintyMs / 1000,
      correctionMethod: "ADAPTER_RECEIVE_TIME_PROXY",clockModelVersion: "mqtt-arrival-proxy-v1",clockDomain: "ADAPTER_MONOTONIC_WALLCLOCK",
      ...(rawSourceTime ? { sourceTimeRaw: rawSourceTime } : {}),
      ...(rawSourceTicks ? { sourceTimeTicks: rawSourceTicks } : {}) },
    measurements,assertions: [],entityBindingStatus: "DECLARED",...extra
  };
}

function genericMeasurement(key: string,property: string,attributes: Json) {
  return { measurementKey: key,measurementStage: "PARSED_NATIVE" as const,observedProperty: property,
    resultKind: "GEOMETRY_SUPPORT" as const,measurementModel: "UGV_MQTT_SOURCE_PAYLOAD",
    measurementModelVersion: "1.0",qualityFlags: ["SOURCE_EVENT_TIME_MISSING"],attributes };
}

function mapGnss(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as Json;
  const longitude = Number(value.longitude),latitude = Number(value.latitude),altitude = Number(value.altitude);
  const measurement = { measurementKey: "position",measurementStage: "PARSED_NATIVE" as const,observedProperty: "position",
    resultKind: "POSITION" as const,analysisSpaceKey: config.analysisSpaceKey,
    sourceGeometry: { type: "Point" as const,coordinates: [longitude,latitude,altitude] as [number,number,number] },altitudeM: altitude,
    uncertainty: { model: "UNKNOWN" as const },measurementModel: "ROS_NAVSATFIX_MQTT",
    measurementModelVersion: "1.0",qualityFlags: ["POSITION_ACCURACY_UNKNOWN","SOURCE_EVENT_TIME_MISSING"],
    continuityToken: config.trackerSessionKey,attributes: value };
  const observation = baseObservation(input,config,0,{ type: "UGV",id: `ugv:${config.deviceId}` },
    { type: "Sensor",id: `device:${config.deviceId}:gnss` },"UGV_POSITION","ugv-position-v1",[measurement],
    { localization: { source: "GNSS",fixStatus: value.status ?? null,accuracy: "UNKNOWN" } },
    { sourceLocalTargetId: config.deviceId,trackerSessionId: config.trackerSessionKey });
  return { observations: [observation],events: [],cursor: { ...input.cursor,lastLongitude: longitude,lastLatitude: latitude } };
}

function mapSpeed(input: MapperInput,config: MapperConfig): MappingResult {
  const raw = typeof input.payload === "number" ? input.payload : Number((input.payload as Json).data);
  const speedMps = raw / 3.6;
  const measurement = { measurementKey: "vehicle-speed",measurementStage: "NORMALIZED" as const,observedProperty: "speed",
    resultKind: "NUMERIC" as const,scalarValue: speedMps,valueUnit: "m/s",measurementModel: "SOURCE_KMH_TO_MPS",
    measurementModelVersion: "1.0",qualityFlags: ["SOURCE_EVENT_TIME_MISSING"],attributes: { rawValue: raw,rawUnit: "km/h" } };
  const observation = baseObservation(input,config,0,{ type: "Device",id: `device:${config.deviceId}:motion` },
    { type: "Device",id: `device:${config.deviceId}:chassis` },"UGV_SPEED","ugv-speed-v1",[measurement],
    { kinematics: { speedMps,sourceAuthority: input.topic } });
  return { observations: [observation],events: [],cursor: { ...input.cursor,lastSpeedMps: speedMps } };
}

function mapPlatform(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as Json;
  const state = value.available === false ? { platform: { available: false } } : {
    platform: { available: true,readyStatus: value.ready_status ?? null,gearStatus: value.gear_status ?? null,
      brakeStatus: value.brake_status ?? null,emergencyStopStatus: value.emergency_stop_status ?? null },
    energy: pick(value,["lvbattery_soc","hvbattery1_soc","hvbattery2_soc","fuel1","fuel2"]),
    thermal: pick(value,["motor_temp","engine_water_temp"]),
    localizationHealth: pick(value,["heading","roll","pitch","ins_init","gnss","location_status"]),
    operation: pick(value,["power_supply_status","operate_mode_status"]),faultSummary: { fault: value.fault ?? null },
    networkHealth: pick(value,["ping_status","packet_loss_rate","average_round_trip_time"]),
    sourceMirrors: pick(value,["chassis_task","eo_task","weapon_task","veh_speed"])
  };
  const observation = baseObservation(input,config,0,{ type: "Device",id: `device:${config.deviceId}:platform` },
    { type: "Device",id: `device:${config.deviceId}:platform` },"UGV_PLATFORM_STATUS","ugv-platform-status-v1",
    [genericMeasurement("platform-status","platformStatus",value)],state);
  return { observations: [observation],events: [],cursor: { ...input.cursor,lastAvailable: value.available !== false } };
}

function mapChassisMission(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as Json; const state = Number(value.state); const prior = numberOr(input.cursor.lastState,-1);
  let epoch = numberOr(input.cursor.missionEpoch,1);
  if ([3,4,5].includes(prior) && [0,1].includes(state)) epoch += 1;
  const missionId = String(value.id); const subjectId = `mission:${config.deviceId}:chassis:${missionId}:${epoch}`;
  const observation = baseObservation(input,config,0,{ type: "Mission",id: subjectId },{ type: "UGV",id: `ugv:${config.deviceId}` },
    "UGV_CHASSIS_MISSION_STATE","ugv-chassis-mission-v1",[genericMeasurement("mission-state","missionState",value)],
    { mission: { kind: "CHASSIS",missionId,type: value.type,state,progress: value.progress,epoch,epochBoundaryInferred: epoch > numberOr(input.cursor.missionEpoch,1) } });
  const transition = chassisEvent[`${prior}:${state}`];
  const events = transition ? [eventFor(input,config,0,subjectId,transition,observation.observationId,{ priorState: prior,state,progress: value.progress })] : [];
  return { observations: [observation],events,cursor: { ...input.cursor,lastState: state,missionEpoch: epoch,lastProgress: value.progress } };
}

function mapReconStatus(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as Json; const state = Number(value.status); const prior = numberOr(input.cursor.lastState,-1);
  let epoch = numberOr(input.cursor.reconEpoch,1);
  if ([9,10,11].includes(prior) && [2,3,4,5].includes(state)) epoch += 1;
  const subjectId = `mission:${config.deviceId}:recon:${config.worldEpoch}:${epoch}`;
  const cameraFault = value.camera_fault === true;
  const patch: Json = { recon: { ...value,reconEpoch: epoch,
    ...(cameraFault ? { reportedFrozenProgress: value.progress ?? value.coverage ?? null } : {}),
    statusUnexpectedInSimulation: state === 13 || state === 99 } };
  const observation = baseObservation(input,config,0,{ type: "Mission",id: subjectId },{ type: "UGV",id: `ugv:${config.deviceId}` },
    "UGV_RECON_MISSION_STATE","ugv-recon-status-v1",[genericMeasurement("recon-status","reconStatus",value)],patch);
  const events: OperationalEventIngest[] = [];
  const transition = state !== prior && state !== 13 && state !== 99 ? reconEvent[state] : undefined;
  if (transition) events.push(eventFor(input,config,events.length,subjectId,transition,observation.observationId,{ priorStatus: prior,status: state }));
  const ack = value.last_cmd_ack as Json | null | undefined; const priorAck = input.cursor.lastCommandAck as Json | undefined;
  if (ack && ack.seq !== priorAck?.seq) {
    events.push(eventFor(input,config,events.length,subjectId,ack.ok === true ? "CONTROL_ACCEPTED_OBSERVED" : "CONTROL_REJECTED_OBSERVED",
      observation.observationId,{ commandAck: ack }));
  }
  return { observations: [observation],events,cursor: { ...input.cursor,lastState: state,reconEpoch: epoch,cameraFault,
    ...(ack ? { lastCommandAck: ack } : {}) } };
}

function mapTargets(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as { targets: Json[] }; const cameraFault = input.cursor.cameraFault === true;
  const observations = value.targets.map((target,index) => {
    const position = target.position as Json; const velocity = target.velocity as Json; const id = String(target.target_id);
    const attributes = { captureTimeRaw: target.capture_time_us,targetId: target.target_id,type: target.type,roleName: target.role_name,
      distanceM: target.distance,confidence: target.confidence,threat: target.threat,damage: target.damage,iff: target.iff,
      lockTime: target.lock_time,pixelPosition: target.pixel_pos };
    const measurements: CanonicalObservationInput["measurements"] = [{ measurementKey: "position",measurementStage: "PARSED_NATIVE",
      observedProperty: "position",resultKind: "POSITION",analysisSpaceKey: config.analysisSpaceKey,
      sourceGeometry: { type: "Point",coordinates: [Number(position.longitude),Number(position.latitude),Number(position.altitude)] },
      altitudeM: Number(position.altitude),uncertainty: { model: "UNKNOWN" },measurementModel: "MAR_TARGET_INFO_WGS84",
      measurementModelVersion: "1.0",qualityFlags: ["POSITION_ACCURACY_UNKNOWN","SOURCE_TIME_TICKS_UNRESOLVED"],
      continuityToken: `${config.worldEpoch}:${id}`,attributes },{ measurementKey: "velocity-enu",measurementStage: "PARSED_NATIVE",
      observedProperty: "velocity",resultKind: "VECTOR",vectorValue: [Number(velocity.vel_e),Number(velocity.vel_n),Number(velocity.vel_u)],
      valueUnit: "m/s",nativeFrame: "ENU",measurementModel: "MAR_TARGET_INFO_VELOCITY",measurementModelVersion: "1.0",
      qualityFlags: [],attributes }];
    return baseObservation(input,config,index,{ type: targetTypes[Number(target.type)] ?? "ObservedTarget",id: `target:carla:${config.worldEpoch}:${id}` },
      { type: "Sensor",id: `device:${config.deviceId}:eo` },"UGV_RECON_TARGET","ugv-recon-target-v1",measurements,
      { target: attributes,reconFrame: { reportedTargetCount: value.targets.length,cameraFaultActiveAtIngest: cameraFault } },
      { sourceLocalTargetId: `${config.worldEpoch}:${id}`,trackerSessionId: `${config.trackerSessionKey}:recon`,
        entityBindingStatus: cameraFault ? "CANDIDATE" : "DECLARED",qualityFlags: cameraFault ? ["SOURCE_EVENT_TIME_MISSING","CAMERA_FAULT_ACTIVE_AT_INGEST"] : ["SOURCE_EVENT_TIME_MISSING"] });
  });
  return { observations,events: [],cursor: { ...input.cursor,lastTargetCount: value.targets.length,
    emptyFrameMeaning: value.targets.length ? null : cameraFault ? "UNOBSERVABLE_DURING_CAMERA_FAULT" : "NO_DETECTIONS_IN_RECON_FRAME" } };
}

function mapException(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as Json; const targetInfo = value.target_info as Json | undefined;
  const sanitizedTarget = targetInfo ? { ...targetInfo,...(typeof targetInfo.reason === "string" ? { reason: targetInfo.reason.slice(0,2048) } : {}) } : {};
  const patch = { exception: { kind: value.kind,level: value.level,errorCode: value.error_code,
    errorNamespace: "AREA_RECON_RUNTIME",targetInfo: sanitizedTarget } };
  const observation = baseObservation(input,config,0,{ type: "Alert",id: `alert:${config.deviceId}:recon:${input.messageId}` },
    { type: "Sensor",id: `device:${config.deviceId}:eo` },"UGV_RECON_EXCEPTION","ugv-recon-exception-v1",
    [genericMeasurement("recon-exception","reconException",value)],patch);
  return { observations: [observation],events: [],cursor: input.cursor };
}

function eventFor(input: MapperInput,config: MapperConfig,ordinal: number,taskId: string,type: OperationalEventIngest["eventType"],
  observationId: string,payload: Json): OperationalEventIngest {
  const identity = { sourceKey: config.sourceKey,inboxMessageId: input.messageId,ordinal,mapperVersion: config.mapperVersion,type,taskId,payload };
  return { dataScopeKey: config.dataScopeKey,sourceAuthority: input.topic,
    sourceEventKey: `mqtt:${config.deviceId}:${encodeURIComponent(input.topic)}:${input.messageId}:${ordinal}`,sourceRevisionNo: 1,
    eventId: `ugvevt_${sha256(canonicalJson(identity))}`,operationalTaskId: taskId,eventType: type,eventTime: input.adapterReceivedAt,
    actorReferenceKeys: [],targetReferenceKeys: [],payload,provenance: [{ evidenceId: observationId,authority: input.topic,
      evidenceType: "CANONICAL_OBSERVATION",observedAt: input.adapterReceivedAt }] };
}

function sourceTimeRaw(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Json;
  if (value.time_us !== undefined) return String(value.time_us);
  const header = value.header as Json | undefined; const stamp = header?.stamp as Json | undefined;
  return stamp ? canonicalJson(stamp) : undefined;
}
function sourceTicks(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Json).time_us;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}
function pick(value: Json,keys: string[]): Json { return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key,value[key]])); }
function numberOr(value: unknown,fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
