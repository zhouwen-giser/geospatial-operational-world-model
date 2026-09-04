import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareUnicodeCodePoints } from "../../packages/platform/contract-runtime/src/index.js";
import { sha256, stableKey } from "../../packages/network-foundation/src/canonical.js";
import type {
  BuiltNetworkArc,
  BuiltNetworkEdge,
  BuiltNetworkNode,
  BuiltNetworkTopology,
  CompiledTurnRestrictions,
  NormalizedPosition
} from "../../packages/network-foundation/src/types.js";

export const LOCKED_OPENDRIVE_HASH = "sha256:f9119c2fa0c73093c2c2d15d262ede56fbcefd3de091f652523559aca13d3481";
export const LOCKED_ORACLE_HASH = "sha256:be045dba9c2bbee109439e0280a28b563b50f1a3ceee4c8783ce34fed8d1429d";

export interface AdmissionChannel {
  readonly channelKey: string;
  readonly sourceNodeKey: string;
  readonly targetNodeKey: string;
  readonly edgeKey: string;
  readonly arcKey: string;
  readonly coordinates: readonly (readonly [number, number, number])[];
  readonly sourceRoadId: string;
  readonly sourceLaneId: number;
  readonly laneSectionStart: number;
  readonly sourceLaneGuid?: string;
  readonly travelDirection: "forward" | "backward";
  readonly isJunctionConnector: boolean;
  readonly physicalRoadGroupKey: string;
  readonly lengthMm: number;
  readonly width: { readonly minM: number; readonly maxM: number; readonly meanM: number };
  readonly defaultSpeedMmPerS: number;
  readonly sourceFeatureReferenceKey: string;
  readonly sourceFeatureVersion: string;
  readonly roadClass: string;
  readonly surface?: string;
  readonly isBridge: boolean;
  readonly isTunnel: boolean;
  readonly layerLevel: number;
  readonly oneway: "FORWARD_ONLY";
  readonly widthMm: number;
  readonly accessAttributes: Readonly<Record<string, unknown>>;
  readonly transitEligible: boolean;
  readonly serviceEligible: boolean;
  readonly accessMask: number;
  readonly profileConstraints: Readonly<Record<string, unknown>>;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface AdmissionPhysicalRoad {
  readonly physicalRoadGroupKey: string;
  readonly sourceRoadId: string;
  readonly coordinates: readonly (readonly [number, number, number])[];
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface AdmissionTransition {
  readonly turnRuleKey: string;
  readonly fromChannelKey: string;
  readonly fromArcKey: string;
  readonly viaNodeKey: string;
  readonly toChannelKey: string;
  readonly toArcKey: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface OpenDriveAdmissionPlan {
  readonly schemaVersion: "1.0";
  readonly sourceArtifactHash: string;
  readonly oracleArtifactHash: string;
  readonly transformContentHash: string;
  readonly compilerVersion: string;
  readonly buildPolicyVersion: string;
  readonly contentHash: string;
  readonly topologyHash?: string;
  readonly datasetReferenceKey: string;
  readonly datasetVersionKey: string;
  readonly graphVersionKey: string;
  readonly counts: {
    readonly physicalRoads: number;
    readonly activeChannels: number;
    readonly regularChannels: number;
    readonly junctionConnectorChannels: number;
    readonly allowedTransitions: number;
    readonly excludedNonDrivingConnectors: number;
    readonly quarantinedChannels: number;
  };
  readonly quarantineRoadIds: readonly string[];
  readonly physicalRoads: readonly AdmissionPhysicalRoad[];
  readonly channels: readonly AdmissionChannel[];
  readonly transitions: readonly AdmissionTransition[];
  readonly transform: Readonly<Record<string, unknown>>;
}

export interface PlannedCatalogFeature {
  readonly featureReferenceKey: string;
  readonly featureVersion: string;
  readonly featureKey: string;
  readonly featureType: "PHYSICAL_ROAD" | "ROUTING_CHANNEL";
  readonly layerKey: "physical_roads" | "routing_channels";
  readonly coordinates: readonly (readonly [number, number, number])[];
  readonly properties: Readonly<Record<string, unknown>>;
  readonly contentHash: string;
}

export interface OpenDriveAdmissionMaterialization {
  readonly plan: OpenDriveAdmissionPlan;
  readonly datasetReferenceKey: string;
  readonly datasetVersion: string;
  readonly datasetContentHash: string;
  readonly graphVersion: string;
  readonly graphContentHash: string;
  readonly catalogFeatures: readonly PlannedCatalogFeature[];
  readonly topology: BuiltNetworkTopology;
  readonly turns: CompiledTurnRestrictions;
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value as number;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function hash(value: unknown, label: string): string {
  const result = text(value, label);
  if (!HASH_PATTERN.test(result)) throw new Error(`${label} must be a sha256 digest`);
  return result;
}

function coordinates(value: unknown, label: string): Array<readonly [number, number, number]> {
  if (!Array.isArray(value) || value.length < 2) throw new Error(`${label} must contain at least two coordinates`);
  return value.map((candidate, index) => {
    if (!Array.isArray(candidate) || candidate.length !== 3) throw new Error(`${label}[${index}] must be [longitude,latitude,altitude]`);
    const longitude = finite(candidate[0], `${label}[${index}].longitude`);
    const latitude = finite(candidate[1], `${label}[${index}].latitude`);
    const altitude = finite(candidate[2], `${label}[${index}].altitude`);
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      throw new Error(`${label}[${index}] is outside EPSG:4326 bounds`);
    }
    return [longitude, latitude, altitude] as const;
  });
}

function parsePhysicalRoad(value: unknown, index: number): AdmissionPhysicalRoad {
  const item = record(value, `physicalRoads[${index}]`);
  return {
    physicalRoadGroupKey: text(item.physicalRoadGroupKey, `physicalRoads[${index}].physicalRoadGroupKey`),
    sourceRoadId: text(item.sourceRoadId, `physicalRoads[${index}].sourceRoadId`),
    coordinates: coordinates(item.coordinates, `physicalRoads[${index}].coordinates`),
    properties: record(item.properties, `physicalRoads[${index}].properties`)
  };
}

function parseChannel(value: unknown, index: number): AdmissionChannel {
  const item = record(value, `channels[${index}]`);
  const width = record(item.width, `channels[${index}].width`);
  const travelDirection = text(item.travelDirection, `channels[${index}].travelDirection`);
  if (travelDirection !== "forward" && travelDirection !== "backward") throw new Error("channel travelDirection is invalid");
  if (typeof item.isJunctionConnector !== "boolean") throw new Error("channel isJunctionConnector must be boolean");
  const result: AdmissionChannel = {
    channelKey: text(item.channelKey, `channels[${index}].channelKey`),
    sourceNodeKey: text(item.sourceNodeKey, `channels[${index}].sourceNodeKey`),
    targetNodeKey: text(item.targetNodeKey, `channels[${index}].targetNodeKey`),
    edgeKey: text(item.edgeKey, `channels[${index}].edgeKey`),
    arcKey: text(item.arcKey, `channels[${index}].arcKey`),
    coordinates: coordinates(item.coordinates, `channels[${index}].coordinates`),
    sourceRoadId: text(item.sourceRoadId, `channels[${index}].sourceRoadId`),
    sourceLaneId: integer(item.sourceLaneId, `channels[${index}].sourceLaneId`),
    laneSectionStart: finite(item.laneSectionStart, `channels[${index}].laneSectionStart`),
    travelDirection,
    isJunctionConnector: item.isJunctionConnector,
    physicalRoadGroupKey: text(item.physicalRoadGroupKey, `channels[${index}].physicalRoadGroupKey`),
    lengthMm: integer(item.lengthMm, `channels[${index}].lengthMm`),
    width: {
      minM: finite(width.minM, `channels[${index}].width.minM`),
      maxM: finite(width.maxM, `channels[${index}].width.maxM`),
      meanM: finite(width.meanM, `channels[${index}].width.meanM`)
    },
    defaultSpeedMmPerS: integer(item.defaultSpeedMmPerS, `channels[${index}].defaultSpeedMmPerS`),
    sourceFeatureReferenceKey: text(item.sourceFeatureReferenceKey, `channels[${index}].sourceFeatureReferenceKey`),
    sourceFeatureVersion: text(item.sourceFeatureVersion, `channels[${index}].sourceFeatureVersion`),
    roadClass: text(item.roadClass, `channels[${index}].roadClass`),
    ...(item.surface === null || item.surface === undefined ? {} : { surface: text(item.surface, `channels[${index}].surface`) }),
    isBridge: item.isBridge === false ? false : item.isBridge === true ? true : (() => { throw new Error("channel isBridge must be boolean"); })(),
    isTunnel: item.isTunnel === false ? false : item.isTunnel === true ? true : (() => { throw new Error("channel isTunnel must be boolean"); })(),
    layerLevel: integer(item.layerLevel, `channels[${index}].layerLevel`),
    oneway: item.oneway === "FORWARD_ONLY" ? "FORWARD_ONLY" : (() => { throw new Error("channel oneway must be FORWARD_ONLY"); })(),
    widthMm: integer(item.widthMm, `channels[${index}].widthMm`),
    accessAttributes: record(item.accessAttributes, `channels[${index}].accessAttributes`),
    transitEligible: item.transitEligible === true ? true : item.transitEligible === false ? false : (() => { throw new Error("channel transitEligible must be boolean"); })(),
    serviceEligible: item.serviceEligible === true ? true : item.serviceEligible === false ? false : (() => { throw new Error("channel serviceEligible must be boolean"); })(),
    accessMask: integer(item.accessMask, `channels[${index}].accessMask`),
    profileConstraints: record(item.profileConstraints, `channels[${index}].profileConstraints`),
    ...(item.sourceLaneGuid === undefined ? {} : { sourceLaneGuid: text(item.sourceLaneGuid, `channels[${index}].sourceLaneGuid`) }),
    ...(item.properties === undefined ? {} : { properties: record(item.properties, `channels[${index}].properties`) })
  };
  if (result.lengthMm <= 0 || result.defaultSpeedMmPerS <= 0 || result.widthMm <= 0 || result.accessMask < 0 || result.width.minM <= 0 ||
      result.width.maxM < result.width.minM || result.width.meanM < result.width.minM || result.width.meanM > result.width.maxM) {
    throw new Error(`channels[${index}] has invalid fixed-point length/speed/width`);
  }
  return result;
}

function parseTransition(value: unknown, index: number): AdmissionTransition {
  const item = record(value, `transitions[${index}]`);
  return {
    turnRuleKey: text(item.turnRuleKey ?? item.ruleKey, `transitions[${index}].turnRuleKey`),
    fromChannelKey: text(item.fromChannelKey, `transitions[${index}].fromChannelKey`),
    fromArcKey: text(item.fromArcKey, `transitions[${index}].fromArcKey`),
    viaNodeKey: text(item.viaNodeKey, `transitions[${index}].viaNodeKey`),
    toChannelKey: text(item.toChannelKey, `transitions[${index}].toChannelKey`),
    toArcKey: text(item.toArcKey, `transitions[${index}].toArcKey`),
    evidence: record(item.evidence, `transitions[${index}].evidence`)
  };
}

function stableReference(value: unknown): string {
  return `wrf_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

function position(coordinate: readonly [number, number, number]): NormalizedPosition {
  return {
    longitudeNanodegrees: Math.round(coordinate[0] * 1_000_000_000),
    latitudeNanodegrees: Math.round(coordinate[1] * 1_000_000_000),
    elevationMm: Math.round(coordinate[2] * 1000)
  };
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate identities`);
}

export async function loadOpenDriveAdmissionPlan(outputRoot: string): Promise<OpenDriveAdmissionPlan> {
  const raw = JSON.parse(await readFile(resolve(outputRoot, "admission-plan.json"), "utf8")) as unknown;
  const item = record(raw, "admission plan");
  if (item.schemaVersion !== "1.0") throw new Error("admission plan schemaVersion must be 1.0");
  const counts = record(item.counts, "admission plan counts");
  const plan: OpenDriveAdmissionPlan = {
    schemaVersion: "1.0",
    sourceArtifactHash: hash(item.sourceArtifactHash, "sourceArtifactHash"),
    oracleArtifactHash: hash(item.oracleArtifactHash, "oracleArtifactHash"),
    transformContentHash: hash(item.transformContentHash, "transformContentHash"),
    compilerVersion: text(item.compilerVersion, "compilerVersion"),
    buildPolicyVersion: text(item.buildPolicyVersion, "buildPolicyVersion"),
    contentHash: hash(item.contentHash, "contentHash"),
    ...(item.topologyHash === undefined ? {} : { topologyHash: hash(item.topologyHash, "topologyHash") }),
    datasetReferenceKey: text(item.datasetReferenceKey, "datasetReferenceKey"),
    datasetVersionKey: text(item.datasetVersionKey, "datasetVersionKey"),
    graphVersionKey: text(item.graphVersionKey, "graphVersionKey"),
    counts: {
      physicalRoads: integer(counts.physicalRoads, "counts.physicalRoads"),
      activeChannels: integer(counts.activeChannels, "counts.activeChannels"),
      regularChannels: integer(counts.regularChannels, "counts.regularChannels"),
      junctionConnectorChannels: integer(counts.junctionConnectorChannels, "counts.junctionConnectorChannels"),
      allowedTransitions: integer(counts.allowedTransitions, "counts.allowedTransitions"),
      excludedNonDrivingConnectors: integer(counts.excludedNonDrivingConnectors, "counts.excludedNonDrivingConnectors"),
      quarantinedChannels: integer(counts.quarantinedChannels, "counts.quarantinedChannels")
    },
    quarantineRoadIds: Array.isArray(item.quarantineRoadIds) ? item.quarantineRoadIds.map((value, index) => text(value, `quarantineRoadIds[${index}]`)) : [],
    physicalRoads: Array.isArray(item.physicalRoads) ? item.physicalRoads.map(parsePhysicalRoad) : [],
    channels: Array.isArray(item.channels) ? item.channels.map(parseChannel) : [],
    transitions: Array.isArray(item.transitions) ? item.transitions.map(parseTransition) : [],
    transform: record(item.transform, "transform")
  };
  validateFixedAcceptance(plan);
  return plan;
}

export function validateFixedAcceptance(plan: OpenDriveAdmissionPlan): void {
  if (plan.sourceArtifactHash !== LOCKED_OPENDRIVE_HASH || plan.oracleArtifactHash !== LOCKED_ORACLE_HASH) {
    throw new Error("admission source lock does not match the approved OpenDRIVE/oracle artifacts");
  }
  const expected = {
    physicalRoads: 40,
    activeChannels: 244,
    regularChannels: 80,
    junctionConnectorChannels: 164,
    allowedTransitions: 336,
    excludedNonDrivingConnectors: 60,
    quarantinedChannels: 2
  };
  for (const [key, value] of Object.entries(expected)) {
    if (plan.counts[key as keyof typeof expected] !== value) throw new Error(`fixed count ${key} must be ${value}`);
  }
  if (plan.physicalRoads.length !== 40 || plan.channels.length !== 244 || plan.transitions.length !== 336) {
    throw new Error("admission arrays do not match their fixed cardinalities");
  }
  if (JSON.stringify([...plan.quarantineRoadIds].sort()) !== JSON.stringify(["6"])) {
    throw new Error("Road 6 must be the only quarantined road");
  }
  assertUnique(plan.channels.map((channel) => channel.channelKey), "channels");
  assertUnique(plan.channels.map((channel) => channel.edgeKey), "compiler Edge identities");
  assertUnique(plan.channels.map((channel) => channel.arcKey), "compiler Arc identities");
  assertUnique(plan.channels.map((channel) => channel.sourceFeatureReferenceKey), "routing Feature reference identities");
  assertUnique(plan.physicalRoads.map((road) => road.physicalRoadGroupKey), "physical roads");
  assertUnique(plan.transitions.map((transition) => `${transition.fromChannelKey}->${transition.toChannelKey}`), "transitions");
  const channelKeys = new Set(plan.channels.map((channel) => channel.channelKey));
  if (plan.channels.some((channel) => channel.sourceRoadId === "6")) throw new Error("Road 6 leaked into active channels");
  for (const transition of plan.transitions) {
    if (!channelKeys.has(transition.fromChannelKey) || !channelKeys.has(transition.toChannelKey)) {
      throw new Error("transition references an inactive channel");
    }
  }
  if (!/^wrf_[0-9a-f]{32}$/u.test(plan.datasetReferenceKey) ||
      plan.channels.some((channel) => !/^wrf_[0-9a-f]{32}$/u.test(channel.sourceFeatureReferenceKey) ||
        !/^nd_[0-9a-f]{64}$/u.test(channel.sourceNodeKey) || !/^nd_[0-9a-f]{64}$/u.test(channel.targetNodeKey) ||
        !/^ed_[0-9a-f]{64}$/u.test(channel.edgeKey) || !/^ar_[0-9a-f]{64}$/u.test(channel.arcKey)) ||
      plan.transitions.some((transition) => !/^tr_[0-9a-f]{64}$/u.test(transition.turnRuleKey))) {
    throw new Error("compiler public identities do not satisfy GOWM Catalog/Network constraints");
  }
  const adjacent = new Map(plan.channels.map((channel) => [channel.channelKey, new Set<string>()]));
  for (const transition of plan.transitions) {
    adjacent.get(transition.fromChannelKey)!.add(transition.toChannelKey);
    adjacent.get(transition.toChannelKey)!.add(transition.fromChannelKey);
  }
  const visited = new Set<string>();
  const queue = [plan.channels[0]!.channelKey];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...adjacent.get(current)!);
  }
  if (visited.size !== 244) throw new Error("active channels are not in one weak component");
}

export function materializeAdmissionPlan(plan: OpenDriveAdmissionPlan): OpenDriveAdmissionMaterialization {
  const physicalFeatures: PlannedCatalogFeature[] = plan.physicalRoads.map((road) => {
    const featureKey = `physical-road:${road.physicalRoadGroupKey}`;
    const properties = { ...road.properties, sourceRoadId: road.sourceRoadId, physicalRoadGroupKey: road.physicalRoadGroupKey };
    return {
      featureReferenceKey: stableReference({ kind: "OPENDRIVE_PHYSICAL_ROAD", featureKey, source: plan.sourceArtifactHash }),
      featureVersion: plan.datasetVersionKey,
      featureKey,
      featureType: "PHYSICAL_ROAD",
      layerKey: "physical_roads",
      coordinates: road.coordinates,
      properties,
      contentHash: sha256({ geometry: { type: "LineString", coordinates: road.coordinates }, properties })
    };
  });
  const channelFeatures: PlannedCatalogFeature[] = plan.channels.map((channel) => {
    const featureKey = `routing-channel:${channel.channelKey}`;
    const properties = {
      ...channel.properties,
      channelKey: channel.channelKey,
      sourceRoadId: channel.sourceRoadId,
      sourceLaneId: channel.sourceLaneId,
      laneSectionStart: channel.laneSectionStart,
      ...(channel.sourceLaneGuid === undefined ? {} : { sourceLaneGuid: channel.sourceLaneGuid }),
      travelDirection: channel.travelDirection,
      isJunctionConnector: channel.isJunctionConnector,
      physicalRoadGroupKey: channel.physicalRoadGroupKey,
      roadClass: "XODR_TOWN",
      surfaceKnowledge: "MISSING_IN_SOURCE",
      structureSemantics: "MISSING_IN_SOURCE",
      defaultSpeedMmPerS: channel.defaultSpeedMmPerS
    };
    return {
      featureReferenceKey: channel.sourceFeatureReferenceKey,
      featureVersion: channel.sourceFeatureVersion,
      featureKey,
      featureType: "ROUTING_CHANNEL",
      layerKey: "routing_channels",
      coordinates: channel.coordinates,
      properties,
      contentHash: sha256({ geometry: { type: "LineString", coordinates: channel.coordinates }, properties })
    };
  });
  const channelFeature = new Map(plan.channels.map((channel, index) => [channel.channelKey, channelFeatures[index]!]));
  const nodePositions = new Map<string, NormalizedPosition>();
  for (const channel of plan.channels) {
    const source = position(channel.coordinates[0]!);
    const target = position(channel.coordinates.at(-1)!);
    for (const [key, candidate] of [[channel.sourceNodeKey, source], [channel.targetNodeKey, target]] as const) {
      const previous = nodePositions.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) throw new Error("clustered topology node coordinates diverge");
      nodePositions.set(key, candidate);
    }
  }
  const nodes: BuiltNetworkNode[] = [...nodePositions].map(([sourceKey, nodePosition]) => ({
    nodeKey: sourceKey, position: nodePosition, topologyIdentity: `opendrive-node:${sourceKey}`
  })).sort((left, right) => compareUnicodeCodePoints(left.nodeKey, right.nodeKey));
  const edgeByChannel = new Map<string, BuiltNetworkEdge>();
  const arcByChannel = new Map<string, BuiltNetworkArc>();
  for (const channel of plan.channels) {
    const feature = channelFeature.get(channel.channelKey)!;
    const sourceNodeKey = channel.sourceNodeKey;
    const targetNodeKey = channel.targetNodeKey;
    const edgeKey = channel.edgeKey;
    const positions = channel.coordinates.map(position);
    const edge: BuiltNetworkEdge = {
      edgeKey,
      sourceFeatureReferenceKey: feature.featureReferenceKey,
      sourceFeatureVersion: feature.featureVersion,
      sourceNodeKey,
      targetNodeKey,
      splitStartPpm: 0,
      splitEndPpm: 1_000_000,
      positions,
      lengthMm: channel.lengthMm,
      roadClass: channel.roadClass,
      ...(channel.surface === undefined ? {} : { surface: channel.surface }),
      isBridge: channel.isBridge,
      isTunnel: channel.isTunnel,
      layerLevel: channel.layerLevel,
      oneway: channel.oneway,
      widthMm: channel.widthMm,
      laneCount: 1,
      accessAttributes: channel.accessAttributes
    };
    const arc: BuiltNetworkArc = {
      arcKey: channel.arcKey,
      edgeKey,
      sourceNodeKey,
      targetNodeKey,
      direction: "FORWARD",
      positions,
      lengthMm: channel.lengthMm,
      defaultSpeedMmPerS: channel.defaultSpeedMmPerS,
      transitEligible: channel.transitEligible,
      serviceEligible: channel.serviceEligible,
      accessMask: channel.accessMask,
      profileConstraints: channel.profileConstraints
    };
    edgeByChannel.set(channel.channelKey, edge);
    arcByChannel.set(channel.channelKey, arc);
  }
  const edges = [...edgeByChannel.values()].sort((left, right) => compareUnicodeCodePoints(left.edgeKey, right.edgeKey));
  const arcs = [...arcByChannel.values()].sort((left, right) => compareUnicodeCodePoints(left.arcKey, right.arcKey));
  const pairwiseRules = plan.transitions.map((transition) => {
    const from = arcByChannel.get(transition.fromChannelKey)!;
    const to = arcByChannel.get(transition.toChannelKey)!;
    if (from.targetNodeKey !== to.sourceNodeKey) throw new Error("allowed transition is not contiguous at its compiled node");
    if (transition.fromArcKey !== from.arcKey || transition.toArcKey !== to.arcKey || transition.viaNodeKey !== from.targetNodeKey) {
      throw new Error("transition compiler identities diverge from channel topology");
    }
    const core = {
      fromArcKey: transition.fromArcKey,
      viaNodeKey: transition.viaNodeKey,
      toArcKey: transition.toArcKey,
      ruleType: "ALLOWED_ONLY" as const,
      penaltyUnits: 0,
      profileFilter: {},
      evidence: [{
        ...transition.evidence,
        fromChannelKey: transition.fromChannelKey,
        toChannelKey: transition.toChannelKey,
        sourceArtifactHash: plan.sourceArtifactHash
      }]
    };
    const ruleKey = transition.turnRuleKey;
    return { ruleKey, ...core, contentHash: sha256({ ruleKey, ...core }) };
  }).sort((left, right) => compareUnicodeCodePoints(left.ruleKey, right.ruleKey));
  const topologyHash = plan.topologyHash ?? sha256({ nodes: nodes.map(({ nodeKey }) => nodeKey), edges: edges.map(({ edgeKey }) => edgeKey), arcs: arcs.map(({ arcKey }) => arcKey), transitions: pairwiseRules.map(({ ruleKey }) => ruleKey) });
  const topology: BuiltNetworkTopology = {
    nodes,
    edges,
    arcs,
    topologyHash,
    contentHash: plan.contentHash,
    diagnostics: []
  };
  const turns: CompiledTurnRestrictions = {
    pairwiseRules,
    sequenceRules: [],
    automaton: { states: [{ stateId: 0, prefix: [] }], rules: [], automatonHash: sha256({ rules: [] }) },
    diagnostics: [],
    contentHash: sha256({ pairwiseRules })
  };
  const catalogFeatures = [...physicalFeatures, ...channelFeatures];
  const datasetContentHash = plan.contentHash;
  const datasetReferenceKey = plan.datasetReferenceKey;
  const datasetVersion = plan.datasetVersionKey;
  const graphContentHash = plan.contentHash;
  const graphVersion = plan.graphVersionKey;
  return { plan, datasetReferenceKey, datasetVersion, datasetContentHash, graphVersion, graphContentHash, catalogFeatures, topology, turns };
}
