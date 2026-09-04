import { canonicalJson } from "../../../observation-model/src/canonical.js";
import type { CanonicalObservationInput } from "../../../world-model-core/src/types.js";
import type { OperationalEventIngest } from "../../../operational-model/src/events.js";
import { sha256, type UgvAuthorityTopic } from "./contracts.js";
import {
  approximateDistanceM,
  DEFAULT_UGV_SAMPLING_POLICY,
  elapsedSince,
  samplingPolicyHash,
  stableChanged,
  type UgvSamplingPolicy
} from "./sampling.js";

type Json = Record<string, unknown>;
export interface MapperConfig {
  deviceId: string; dataScopeKey: string; sourceKey: string; producerPipelineKey: string;
  scenarioId: string; worldEpoch: string; trackerSessionKey: string; analysisSpaceKey: string;
  analysisSrid: number; arrivalUncertaintyMs: number; mapperVersion: string;
  samplingPolicy?: UgvSamplingPolicy;
  maxTargetsPerFrame?: number;
}
export interface MapperInput {
  messageId: string; topic: UgvAuthorityTopic; payloadSha256: string; payload: unknown;
  adapterReceivedAt: string; retained: boolean; cursor: Json; streamContext?: Json;
}
export interface MappingResult {
  observations: CanonicalObservationInput[];
  events: OperationalEventIngest[];
  cursor: Json;
  streamContext?: Json;
  ignoredReason?: string;
}

const targetTypes: Record<number,string> = { 1: "PERSON",2: "VEHICLE",3: "ARMOR",4: "BUILDING" };
const CHASSIS_STATE_LABELS: Record<number,string> = {
  0: "未开始",1: "运行中",2: "已暂停",3: "已终止",4: "已结束",5: "已失败"
};
const RECON_STATUS_LABELS: Record<number,string> = {
  1: "IDLE",2: "IN_CONFIGURE",3: "READY",4: "IN_START",5: "RUNNING",6: "IN_RECOVERY",
  7: "IN_PAUSE",8: "PAUSED",9: "TERMINATED",10: "FAILED",11: "FINISHED",12: "IN_STOP",
  13: "IN_MANUAL_INTERVENTION",99: "UNKNOWN"
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
  const estimateMs = Date.parse(estimate);
  const start = new Date(estimateMs - config.arrivalUncertaintyMs).toISOString();
  const end = new Date(estimateMs + config.arrivalUncertaintyMs + 1).toISOString();
  const rawSourceTime = sourceTimeRaw(input.payload);
  const rawSourceTicks = sourceTicks(input.payload);
  const policy = config.samplingPolicy ?? DEFAULT_UGV_SAMPLING_POLICY;
  const timeQualityFlags = rawSourceTime ? ["SOURCE_EVENT_TIME_MISSING","SOURCE_TIME_TICKS_UNRESOLVED"] : ["SOURCE_EVENT_TIME_MISSING"];
  return {
    schemaVersion: "1.2",observationId,dataScopeKey: config.dataScopeKey,sourceRecordKey,sourceRevisionNo: 1,
    originKind: "SIMULATION",observer,subject,observationType,source: config.sourceKey,datastreamKey,
    producerPipelineKey: config.producerPipelineKey,rawReference: `ugv-inbox://${input.messageId}`,
    qualityFlags: timeQualityFlags,metadata: { mqttTopic: input.topic,payloadSha256: input.payloadSha256,
      mapperVersion: config.mapperVersion,scenarioId: config.scenarioId,worldEpoch: config.worldEpoch,
      samplingPolicyVersion: policy.version,samplingPolicyHash: samplingPolicyHash(policy) },
    ...(statePatch ? { statePatch } : {}),timeSolution: { phenomenonTimeEstimate: estimate,
      phenomenonTimeWindow: { start,end },uncertaintySeconds: config.arrivalUncertaintyMs / 1000,
      correctionMethod: "MQTT_ADAPTER_RECEIVE_TIME_PROXY",clockModelVersion: "mqtt-arrival-proxy-v1",clockDomain: "ADAPTER_WALL_CLOCK",
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

function numericMeasurement(key: string,property: string,value: unknown,unit: string,attributes: Json = {}) {
  return { measurementKey: key,measurementStage: "PARSED_NATIVE" as const,observedProperty: property,
    resultKind: "NUMERIC" as const,scalarValue: Number(value),valueUnit: unit,
    measurementModel: "UGV_MQTT_SOURCE_PAYLOAD",measurementModelVersion: "source-schema-lock",
    qualityFlags: ["SOURCE_EVENT_TIME_MISSING"],attributes };
}

function mapGnss(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as Json;
  const longitude = Number(value.longitude),latitude = Number(value.latitude),altitude = Number(value.altitude);
  const policy = config.samplingPolicy ?? DEFAULT_UGV_SAMPLING_POLICY;
  const elapsed = elapsedSince(input.adapterReceivedAt,input.cursor.lastEmittedAt);
  const displacementM = approximateDistanceM(longitude,latitude,input.cursor.lastEmittedLongitude,input.cursor.lastEmittedLatitude);
  const emit = displacementM >= policy.gnssForceDisplacementM ||
    (displacementM > 0 && elapsed >= policy.gnssMinimumIntervalMs) || elapsed >= policy.gnssHeartbeatMs;
  if (!emit) return { observations: [],events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt },ignoredReason: "GNSS_RATE_LIMIT" };
  const sourceStatus = value.status as Json | undefined;
  const covariance = Array.isArray(value.position_covariance) ? value.position_covariance : undefined;
  const covarianceUnknown = !covariance || covariance.length !== 9 || Number(value.position_covariance_type ?? 0) === 0;
  const fixUnavailable = !sourceStatus || typeof sourceStatus.status !== "number";
  const gnssQualityFlags = ["SOURCE_EVENT_TIME_MISSING",...(covarianceUnknown ? ["GNSS_ACCURACY_UNKNOWN"] : []),
    ...(fixUnavailable ? ["GNSS_FIX_STATUS_UNAVAILABLE"] : [])];
  const measurement = { measurementKey: "vehicle-position",measurementStage: "NORMALIZED" as const,observedProperty: "POSITION",
    resultKind: "POSITION" as const,analysisSpaceKey: config.analysisSpaceKey,
    sourceGeometry: { type: "Point" as const,coordinates: [longitude,latitude,altitude] as [number,number,number] },altitudeM: altitude,
    uncertainty: { model: "UNKNOWN" as const },measurementModel: "ROS2_NAVSATFIX_MQTT",
    measurementModelVersion: "source-schema-lock",qualityFlags: gnssQualityFlags,
    continuityToken: config.trackerSessionKey,attributes: value };
  const observation = baseObservation(input,config,0,{ type: "UGV",id: `ugv:${config.deviceId}` },
    { type: "Sensor",id: `sensor:${config.deviceId}:gnss` },"UGV_POSITION","ugv-position-v1",[measurement],
    { localization: { gnssAvailable: true,sourceTopic: input.topic } },
    { sourceLocalTargetId: config.deviceId,trackerSessionId: config.trackerSessionKey });
  return { observations: [observation],events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt,
    lastEmittedAt: input.adapterReceivedAt,lastEmittedLongitude: longitude,lastEmittedLatitude: latitude } };
}

function mapSpeed(input: MapperInput,config: MapperConfig): MappingResult {
  const raw = typeof input.payload === "number" ? input.payload : Number((input.payload as Json).data);
  const speedMps = raw / 3.6;
  const policy = config.samplingPolicy ?? DEFAULT_UGV_SAMPLING_POLICY;
  const priorSpeed = input.cursor.lastEmittedSpeedMps;
  const elapsed = elapsedSince(input.adapterReceivedAt,input.cursor.lastEmittedAt);
  const changed = typeof priorSpeed !== "number" || Math.abs(speedMps-priorSpeed) >= policy.speedForceDeltaMps;
  if (!changed && elapsed < policy.speedMinimumIntervalMs) {
    return { observations: [],events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt },ignoredReason: "SPEED_RATE_LIMIT" };
  }
  const measurement = { measurementKey: "vehicle-speed",measurementStage: "NORMALIZED" as const,observedProperty: "SPEED",
    resultKind: "NUMERIC" as const,scalarValue: speedMps,valueUnit: "m/s",measurementModel: "SOURCE_KMH_TO_MPS",
    measurementModelVersion: "source-schema-lock",qualityFlags: ["SOURCE_EVENT_TIME_MISSING"],attributes: { rawValue: raw,rawUnit: "km/h" } };
  const observation = baseObservation(input,config,0,{ type: "Device",id: `device:${config.deviceId}:motion` },
    { type: "Device",id: `device:${config.deviceId}:chassis` },"UGV_SPEED","ugv-speed-v1",[measurement],
    { kinematics: { speedMps,speedSource: "UGV_SPEED_TOPIC" } });
  return { observations: [observation],events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt,
    lastEmittedAt: input.adapterReceivedAt,lastEmittedSpeedMps: speedMps } };
}

function mapPlatform(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as Json;
  const policy = config.samplingPolicy ?? DEFAULT_UGV_SAMPLING_POLICY;
  const immediateState = pick(value,["available","fault","emergency_stop_status","gear_status","operate_mode_status",
    "ping_status","packet_loss_rate","average_round_trip_time"]);
  const changed = stableChanged(immediateState,input.cursor.lastImmediateState);
  if (!changed && elapsedSince(input.adapterReceivedAt,input.cursor.lastEmittedAt) < policy.platformMinimumIntervalMs) {
    return { observations: [],events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt },ignoredReason: "PLATFORM_RATE_LIMIT" };
  }
  const state = value.available === false ? { availability: { available: false } } : {
    availability: { available: true },
    energy: {
      lvBatterySoc: value.lvbattery_soc ?? null,hvBattery1Soc: value.hvbattery1_soc ?? null,
      hvBattery2Soc: value.hvbattery2_soc ?? null,fuel1: value.fuel1 ?? null,fuel2: value.fuel2 ?? null
    },
    thermal: { motorTemp: value.motor_temp ?? null,engineWaterTemp: value.engine_water_temp ?? null },
    vehicleStatus: { readyStatus: value.ready_status ?? null,gearStatus: value.gear_status ?? null,
      brakeStatus: value.brake_status ?? null,emergencyStopStatus: value.emergency_stop_status ?? null },
    localizationHealth: { headingDegCompass: value.heading ?? null,rollDeg: value.roll ?? null,pitchDeg: value.pitch ?? null,
      insInit: value.ins_init ?? null,gnss: value.gnss ?? null,locationStatus: value.location_status ?? null },
    operation: { powerSupplyStatus: value.power_supply_status ?? null,operateModeStatus: value.operate_mode_status ?? null },
    faultSummary: { fault: value.fault ?? null },
    networkHealth: { pingStatus: value.ping_status ?? null,packetLossRate: value.packet_loss_rate ?? null,
      averageRoundTripTime: value.average_round_trip_time ?? null },
    sourceMirrors: {
      vehicleSpeed: { value: value.veh_speed ?? null,authority: "MIRROR_ONLY" },
      chassisTask: { value: value.chassis_task ?? null,authority: "MIRROR_ONLY" },
      eoTask: { value: value.eo_task ?? null,authority: "MIRROR_ONLY" },
      weaponTask: { value: value.weapon_task ?? null,authority: "MIRROR_ONLY" },
      gimbal: { value: value.gimbal ?? null,authority: "MIRROR_ONLY" }
    }
  };
  const numericUnits: Record<string,string> = {
    lvbattery_soc: "percent",hvbattery1_soc: "percent",hvbattery2_soc: "percent",fuel1: "percent",fuel2: "percent",
    motor_temp: "degC",engine_water_temp: "degC",heading: "degree",roll: "degree",pitch: "degree",
    packet_loss_rate: "percent",average_round_trip_time: "ms"
  };
  const measurements: CanonicalObservationInput["measurements"] = [genericMeasurement("platform-status","PLATFORM_STATUS",value)];
  for (const [key,unit] of Object.entries(numericUnits)) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) measurements.push(numericMeasurement(key,key.toUpperCase(),value[key],unit,{ sourceField: key }));
  }
  const observation = baseObservation(input,config,0,{ type: "Device",id: `device:${config.deviceId}:platform` },
    { type: "Device",id: `device:${config.deviceId}:platform` },"UGV_PLATFORM_STATUS","ugv-platform-status-v1",
    measurements,state);
  return { observations: [observation],events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt,
    lastEmittedAt: input.adapterReceivedAt,lastImmediateState: immediateState } };
}

function mapChassisMission(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as Json; const state = Number(value.state); const prior = numberOr(input.cursor.lastState,-1);
  const missionId = String(value.id); const sameMission = input.cursor.lastMissionId === missionId;
  let epoch = sameMission ? numberOr(input.cursor.missionEpoch,1) : 1;
  const epochInferred = sameMission && [3,4,5].includes(prior) && [0,1].includes(state);
  if (epochInferred) epoch += 1;
  const policy = config.samplingPolicy ?? DEFAULT_UGV_SAMPLING_POLICY;
  const stateChanged = !sameMission || prior !== state;
  const progressChanged = typeof input.cursor.lastProgress !== "number" ||
    Math.abs(Number(value.progress)-Number(input.cursor.lastProgress)) >= policy.chassisProgressDeltaPercent;
  const heartbeat = elapsedSince(input.adapterReceivedAt,input.cursor.lastEmittedAt) >= policy.chassisHeartbeatMs;
  if (!stateChanged && !progressChanged && !heartbeat) {
    return { observations: [],events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt },ignoredReason: "CHASSIS_PROGRESS_RATE_LIMIT" };
  }
  const subjectId = `mission:${config.deviceId}:chassis:${missionId}:${epoch}`;
  const observation = baseObservation(input,config,0,{ type: "Mission",id: subjectId },{ type: "Device",id: `device:${config.deviceId}:platform` },
    "UGV_CHASSIS_MISSION_STATE","ugv-chassis-mission-v1",[genericMeasurement("mission-state","missionState",value)],
    { chassisMission: { missionId: value.id,missionType: value.type,state,stateLabel: CHASSIS_STATE_LABELS[state],
      progress: value.progress,stateCodeSystem: "MISSION_STATE",missionEpoch: epoch } },
    epochInferred ? { qualityFlags: ["SOURCE_EVENT_TIME_MISSING","MISSION_EPOCH_INFERRED"] } : {});
  const transition = stateChanged ? chassisTransition(prior,state) : undefined;
  const events = transition ? [eventFor(input,config,0,subjectId,transition,observation.observationId,{ priorState: prior,state,progress: value.progress })] : [];
  return { observations: [observation],events,cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt,
    lastEmittedAt: input.adapterReceivedAt,lastMissionId: missionId,lastState: state,missionEpoch: epoch,lastProgress: value.progress } };
}

function mapReconStatus(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as Json; const state = Number(value.status); const prior = numberOr(input.cursor.lastState,-1);
  let epoch = numberOr(input.cursor.reconEpoch,1);
  const startsNewRun = [1,9,10,11].includes(prior) && [2,3,4,5].includes(state);
  if (startsNewRun) epoch += 1;
  const inferredMidRun = prior === -1 && state === 5;
  const subjectId = `mission:${config.deviceId}:recon:${config.worldEpoch}:${epoch}`;
  const cameraFault = value.camera_fault === true;
  const unexpected = state === 13 || state === 99;
  const region = normalizeReconRegion(value.region);
  const ack = value.last_cmd_ack as Json | null | undefined;
  const priorAck = input.cursor.lastCommandAck as Json | undefined;
  const immediateState = { status: state,cameraFault,outOfRange: value.out_of_range === true,lock: value.lock ?? null,
    lastCommandAck: ack ?? null };
  const stateChanged = prior !== state;
  const immediateChanged = stableChanged(immediateState,input.cursor.lastImmediateState);
  const coverageChanged = typeof value.coverage === "number" &&
    (typeof input.cursor.lastCoverage !== "number" ||
      Math.abs(value.coverage-Number(input.cursor.lastCoverage)) >= (config.samplingPolicy ?? DEFAULT_UGV_SAMPLING_POLICY).reconCoverageDeltaPercent);
  const elapsed = elapsedSince(input.adapterReceivedAt,input.cursor.lastEmittedAt);
  if (!stateChanged && !immediateChanged && !coverageChanged && elapsed < (config.samplingPolicy ?? DEFAULT_UGV_SAMPLING_POLICY).reconMinimumIntervalMs) {
    return { observations: [],events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt },ignoredReason: "RECON_STATUS_RATE_LIMIT" };
  }
  const authoritativeProgress = cameraFault ? {} : {
    progressPercent: value.progress ?? null,coveragePercent: value.coverage ?? null,
    coverageCovered: value.coverage_covered ?? null,coverageTotal: value.coverage_total ?? null
  };
  const patch: Json = { recon: {
    status: state,statusLabel: RECON_STATUS_LABELS[state] ?? value.status_label,statusCodeSystem: "MOTION_STATUS",
    scanMode: value.scan_mode ?? null,scanModeLabel: value.scan_mode_label ?? null,scanPitchDeg: value.scan_pitch ?? null,
    outOfRange: value.out_of_range ?? false,...authoritativeProgress,
    ...(cameraFault ? { reportedFrozenProgress: { progressPercent: value.progress ?? null,coveragePercent: value.coverage ?? null,
      coverageCovered: value.coverage_covered ?? null,coverageTotal: value.coverage_total ?? null } } : {}),
    coverageIncomplete: value.coverage_incomplete ?? false,coverageReason: value.coverage_reason ?? "",eoFovDeg: value.eo_fov ?? null,
    scanNum: value.scan_num ?? null,workMode: value.work_mode ?? null,reconType: value.recon_type ?? null,
    loadStatus: value.load_status ?? null,loadStatusLabel: value.load_status_label ?? null,lock: value.lock ?? {},
    attackReady: value.attack_ready ?? false,lastCommandAck: ack ?? null,reconRunEpoch: epoch,
    ...(region.region ? { region: region.region } : {})
  },payloadHealth: { cameraFault } };
  const qualityFlags = ["SOURCE_EVENT_TIME_MISSING",...(unexpected ? ["UNEXPECTED_RECON_STATUS"] : []),
    ...(inferredMidRun ? ["RECON_RUN_INFERRED_MID_RUN"] : []),...(region.invalid ? ["INVALID_RECON_REGION"] : [])];
  const observation = baseObservation(input,config,0,{ type: "Mission",id: subjectId },{ type: "UGV",id: `ugv:${config.deviceId}` },
    "UGV_RECON_STATUS","ugv-recon-status-v1",[genericMeasurement("recon-status","RECON_STATUS",value)],patch,{ qualityFlags });
  observation.metadata = { ...observation.metadata,reconRunIdentity: subjectId };
  const events: OperationalEventIngest[] = [];
  let runStarted = startsNewRun || prior === -1 ? false : input.cursor.runStarted === true;
  const transition = !unexpected && stateChanged ? reconTransition(prior,state,runStarted) : undefined;
  if (transition) {
    events.push(eventFor(input,config,events.length,subjectId,transition,observation.observationId,
      { priorStatus: prior,status: state,reconRunIdentity: subjectId }));
    if (transition === "EXECUTION_STARTED_OBSERVED") runStarted = true;
  }
  if (ack && ack.seq !== priorAck?.seq) {
    events.push(eventFor(input,config,events.length,subjectId,ack.ok === true ? "CONTROL_ACCEPTED_OBSERVED" : "CONTROL_REJECTED_OBSERVED",
      observation.observationId,{ commandAck: ack,reconRunIdentity: subjectId }));
  }
  const streamContext = { ...(input.streamContext ?? {}),cameraFault,lastReconStatus: state,reconEpoch: epoch,
    reconRunIdentity: subjectId,reconRunStarted: runStarted };
  return { observations: [observation],events,cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt,
    lastEmittedAt: input.adapterReceivedAt,lastState: state,reconEpoch: epoch,runStarted,cameraFault,
    lastImmediateState: immediateState,lastCoverage: value.coverage ?? null,...(ack ? { lastCommandAck: ack } : {}) },streamContext };
}

function mapTargets(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as { targets: Json[] };
  const maximumTargets = config.maxTargetsPerFrame ?? 256;
  if (value.targets.length > maximumTargets) throw new Error(`target frame exceeds configured maximum ${maximumTargets}`);
  const context = input.streamContext ?? {};
  const cameraFault = context.cameraFault === true;
  const reconStatus = numberOr(context.lastReconStatus,-1);
  const reconRunIdentity = typeof context.reconRunIdentity === "string"
    ? context.reconRunIdentity : `mission:${config.deviceId}:recon:${config.worldEpoch}:${numberOr(context.reconEpoch,1)}`;
  if (value.targets.length === 0) {
    const frameMeaning = cameraFault ? "UNOBSERVABLE_DURING_CAMERA_FAULT"
      : [8,9,11,12].includes(reconStatus) ? "CACHE_CLEAR_FRAME"
      : reconStatus === 5 ? "REPORTED_TARGET_COUNT_ZERO" : "EMPTY_FRAME_UNINTERPRETED";
    const frameChanged = input.cursor.lastEmptyFrameMeaning !== frameMeaning || input.cursor.lastReconStatus !== reconStatus;
    if (!frameChanged && elapsedSince(input.adapterReceivedAt,input.cursor.lastEmittedAt) <
      (config.samplingPolicy ?? DEFAULT_UGV_SAMPLING_POLICY).targetMinimumIntervalMs) {
      return { observations: [],events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt },ignoredReason: "TARGET_RATE_LIMIT" };
    }
    const observation = baseObservation(input,config,0,{ type: "Mission",id: reconRunIdentity },
      { type: "Sensor",id: `device:${config.deviceId}:eo` },"UGV_RECON_TARGET_FRAME","ugv-recon-target-v1",
      [genericMeasurement("recon-target-frame","RECON_TARGET_FRAME",{ reportedTargetCount: 0,frameMeaning,reconStatus,cameraFault })],
      { reconFrame: { reportedTargetCount: 0,frameMeaning,reconStatus,cameraFault,reconRunIdentity } },
      { entityBindingStatus: cameraFault ? "CANDIDATE" : "DECLARED",
        qualityFlags: ["SOURCE_EVENT_TIME_MISSING",...(cameraFault ? ["CAMERA_FAULT_ACTIVE_AT_INGEST"] : [])] });
    return { observations: [observation],events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt,
      lastEmittedAt: input.adapterReceivedAt,lastTargetCount: 0,lastEmptyFrameMeaning: frameMeaning } };
  }
  const targetCursors = isJson(input.cursor.targets) ? { ...(input.cursor.targets as Json) } : {};
  const observations: CanonicalObservationInput[] = [];
  for (const [index,target] of value.targets.entries()) {
    const position = target.position as Json; const velocity = target.velocity as Json; const id = String(target.target_id);
    const priorTarget = isJson(targetCursors[id]) ? targetCursors[id] as Json : {};
    const targetChange = { locked: Number(target.lock_time) > 0,iff: target.iff,threat: target.threat,damage: target.damage };
    const force = priorTarget.reconRunIdentity !== reconRunIdentity || stableChanged(targetChange,priorTarget.lastAuthoritativeAttributes);
    if (!force && elapsedSince(input.adapterReceivedAt,priorTarget.lastEmittedAt) < (config.samplingPolicy ?? DEFAULT_UGV_SAMPLING_POLICY).targetMinimumIntervalMs) {
      continue;
    }
    const attributes = { captureTimeRaw: target.capture_time_us,targetId: target.target_id,type: target.type,roleName: target.role_name,
      distanceM: target.distance,confidence: target.confidence,threat: target.threat,damage: target.damage,iff: target.iff,
      lockTime: target.lock_time,pixelPosition: target.pixel_pos };
    const measurements: CanonicalObservationInput["measurements"] = [{ measurementKey: "position",measurementStage: "PARSED_NATIVE",
      observedProperty: "POSITION",resultKind: "POSITION",analysisSpaceKey: config.analysisSpaceKey,
      sourceGeometry: { type: "Point",coordinates: [Number(position.longitude),Number(position.latitude),Number(position.altitude)] },
      altitudeM: Number(position.altitude),uncertainty: { model: "UNKNOWN" },measurementModel: "MAR_TARGET_INFO_WGS84",
      measurementModelVersion: "source-schema-lock",algorithmConfidence: Number(target.confidence),
      qualityFlags: ["TARGET_POSITION_ACCURACY_UNKNOWN","SOURCE_TIME_TICKS_UNRESOLVED"],
      continuityToken: `${config.worldEpoch}:${id}`,attributes },{ measurementKey: "velocity-enu",measurementStage: "PARSED_NATIVE",
      observedProperty: "VELOCITY",resultKind: "VECTOR",vectorValue: [Number(velocity.vel_e),Number(velocity.vel_n),Number(velocity.vel_u)],
      valueUnit: "m/s",nativeFrame: "ENU",measurementModel: "MAR_TARGET_INFO_VELOCITY",measurementModelVersion: "1.0",
      qualityFlags: [],attributes },numericMeasurement("distance","DISTANCE",target.distance,"m",{ sourceField: "distance" }),
      numericMeasurement("confidence","CONFIDENCE",target.confidence,"ratio",{ sourceField: "confidence" }),
      numericMeasurement("threat","THREAT",target.threat,"score",{ sourceField: "threat",range: [0,10] }),
      numericMeasurement("damage","DAMAGE",target.damage,"SOURCE_ENUM",{ sourceField: "damage" }),
      numericMeasurement("lock-time","LOCK_TIME",target.lock_time,"s",{ sourceField: "lock_time" })];
    const observation = baseObservation(input,config,index,{ type: targetTypes[Number(target.type)] ?? "ObservedTarget",id: `target:carla:${config.worldEpoch}:${id}` },
      { type: "Sensor",id: `device:${config.deviceId}:eo` },"UGV_RECON_TARGET","ugv-recon-target-v1",measurements,
      { target: attributes,reconFrame: { reportedTargetCount: value.targets.length,cameraFaultActiveAtIngest: cameraFault,reconRunIdentity } },
      { sourceLocalTargetId: `${config.worldEpoch}:${id}`,trackerSessionId: reconRunIdentity,
        entityBindingStatus: cameraFault ? "CANDIDATE" : "DECLARED",
        qualityFlags: cameraFault ? ["SOURCE_EVENT_TIME_MISSING","SOURCE_TIME_TICKS_UNRESOLVED","CAMERA_FAULT_ACTIVE_AT_INGEST"]
          : ["SOURCE_EVENT_TIME_MISSING","SOURCE_TIME_TICKS_UNRESOLVED"] });
    observation.assertions = [{ assertionKind: "TARGET_TYPE",label: targetTypes[Number(target.type)] ?? "UNKNOWN",
      basisReference: "MQTT_SOURCE_FIELD:type",inputMeasurementKeys: ["position"] },
    { assertionKind: "TARGET_ROLE",label: String(target.role_name).trim() || "UNKNOWN",basisReference: "MQTT_SOURCE_FIELD:role_name",inputMeasurementKeys: ["position"] },
    { assertionKind: "TARGET_IFF",label: String(target.iff),basisReference: "MQTT_SOURCE_FIELD:iff",inputMeasurementKeys: ["position"] }];
    observations.push(observation);
    targetCursors[id] = { lastEmittedAt: input.adapterReceivedAt,lastAuthoritativeAttributes: targetChange,reconRunIdentity };
  }
  return { observations,events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt,
    lastTargetCount: value.targets.length,targets: targetCursors },...(observations.length === 0 ? { ignoredReason: "TARGET_RATE_LIMIT" } : {}) };
}

function mapException(input: MapperInput,config: MapperConfig): MappingResult {
  const value = input.payload as Json; const targetInfo = value.target_info as Json | undefined;
  const sanitizedTarget = boundedTargetInfo(targetInfo);
  const patch = { exception: { kind: value.kind,level: value.level,errorCode: value.error_code,
    errorNamespace: "AREA_RECON_RUNTIME",targetInfo: sanitizedTarget } };
  const observation = baseObservation(input,config,0,{ type: "Alert",id: `alert:${config.deviceId}:recon:${input.messageId}` },
    { type: "Sensor",id: `device:${config.deviceId}:eo` },"UGV_RECON_EXCEPTION","ugv-recon-exception-v1",
    [genericMeasurement("recon-exception","reconException",value)],patch);
  return { observations: [observation],events: [],cursor: { ...input.cursor,lastSeenAt: input.adapterReceivedAt,lastEmittedAt: input.adapterReceivedAt } };
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

function chassisTransition(prior: number,state: number): OperationalEventIngest["eventType"] | undefined {
  if (state === prior) return undefined;
  if (state === 1) return prior === 2 ? "EXECUTION_RESUMED_OBSERVED" : "EXECUTION_STARTED_OBSERVED";
  if (state === 2) return "EXECUTION_PAUSED_OBSERVED";
  if (state === 3) return "EXECUTION_STOPPED_OBSERVED";
  if (state === 4) return "CONTROL_COMPLETED_REPORTED";
  if (state === 5) return "EXECUTION_FAILED_OBSERVED";
  return undefined;
}

function reconTransition(prior: number,state: number,runStarted: boolean): OperationalEventIngest["eventType"] | undefined {
  if (state === 4) return "EXECUTION_STARTED_OBSERVED";
  if (state === 5 && !runStarted) return "EXECUTION_STARTED_OBSERVED";
  if (state === 6 && (prior === 7 || prior === 8)) return "EXECUTION_RESUMED_OBSERVED";
  if (state === 8) return "EXECUTION_PAUSED_OBSERVED";
  if (state === 9) return "EXECUTION_STOPPED_OBSERVED";
  if (state === 10) return "EXECUTION_FAILED_OBSERVED";
  if (state === 11) return "CONTROL_COMPLETED_REPORTED";
  return undefined;
}

export function worldToGnss(x: number,y: number,z = 0): [number,number,number] {
  return [106.81485 + x / 111_320,29.71950 + y / 110_540,500 + z];
}

function normalizeReconRegion(candidate: unknown): { region?: Json; invalid: boolean } {
  if (candidate === null || candidate === undefined) return { invalid: false };
  if (!isJson(candidate) || !Array.isArray(candidate.points)) return { invalid: true };
  const sourcePoints = candidate.points.filter((point): point is [number,number] =>
    Array.isArray(point) && point.length === 2 && point.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate)));
  const distinct = new Set(sourcePoints.map((point) => `${point[0]}:${point[1]}`));
  if (sourcePoints.length !== candidate.points.length || distinct.size < 3) return { invalid: true };
  const closed = [...sourcePoints];
  const first = closed[0]; const last = closed.at(-1);
  if (!first || !last) return { invalid: true };
  if (first[0] !== last[0] || first[1] !== last[1]) closed.push(first);
  return { invalid: false,region: { type: candidate.type,wgs84Geometry: {
    type: "Polygon",coordinates: [closed.map(([x,y]) => worldToGnss(x,y).slice(0,2))]
  },sourceWorldCoordinates: closed } };
}

function sourceTimeRaw(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Json;
  if (value.time_us !== undefined) return String(value.time_us);
  if (value.capture_time_us !== undefined) return String(value.capture_time_us);
  const header = value.header as Json | undefined; const stamp = header?.stamp as Json | undefined;
  return stamp ? canonicalJson(stamp) : undefined;
}
function sourceTicks(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Json;
  const value = record.time_us ?? record.capture_time_us;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}
function pick(value: Json,keys: string[]): Json { return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key,value[key]])); }
function numberOr(value: unknown,fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function isJson(value: unknown): value is Json { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function boundedTargetInfo(targetInfo: Json | undefined): Json {
  if (!targetInfo) return {};
  const sanitized = { ...targetInfo,...(typeof targetInfo.reason === "string" ? { reason: targetInfo.reason.slice(0,2048) } : {}) };
  if (Buffer.byteLength(canonicalJson(sanitized),"utf8") <= 16_384) return sanitized;
  return { ...(typeof sanitized.reason === "string" ? { reason: sanitized.reason } : {}),
    truncatedForCanonicalState: true,originalSha256: sha256(canonicalJson(targetInfo)) };
}
