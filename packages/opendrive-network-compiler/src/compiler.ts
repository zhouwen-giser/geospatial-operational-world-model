import { readFile } from "node:fs/promises";
import { canonicalJson, compareText, sha256, stableKey, stableReferenceKey } from "./canonical.js";
import { compileLaneGeometry, compileReferenceGeometry, minimumDrivingRoadWidth } from "./geometry.js";
import { createAirportGeoreference, localToGeographic, ORACLE_ARTIFACT_HASH } from "./georeference.js";
import { parseOpenDrive } from "./parser.js";
import { collectSourceChannels, collectSourceTransitions, weakComponents, type SourceChannel } from "./topology.js";

export const COMPILER_VERSION = "opendrive-task-network-compiler-v0.1.0";
export const SOURCE_ARTIFACT_BYTES = 2_101_550;
export const SOURCE_ARTIFACT_HASH = "sha256:f9119c2fa0c73093c2c2d15d262ede56fbcefd3de091f652523559aca13d3481";
export const DEFAULT_OUTPUT_ROOT = "artifacts/opendrive-task-network-v0.1/artifacts";

type Coordinate = [number, number, number];
type GeoJsonFeature = { type: "Feature"; id: string; geometry: { type: "LineString"; coordinates: Coordinate[] }; properties: Record<string, unknown> };
type CompiledChannel = { source: SourceChannel; sourceKey: string; channelKey: string; edgeKey: string; arcKey: string; sourceNodeKey: string; targetNodeKey: string; localCoordinates: Coordinate[]; coordinates: Coordinate[]; properties: Record<string, unknown> };

class UnionFind {
  private readonly parent = new Map<string, string>();
  add(value: string): void { if (!this.parent.has(value)) this.parent.set(value, value); }
  find(value: string): string { const parent = this.parent.get(value); if (!parent) throw new Error(`unknown endpoint ${value}`); if (parent === value) return value; const root = this.find(parent); this.parent.set(value, root); return root; }
  union(a: string, b: string): void { const x = this.find(a); const y = this.find(b); if (x === y) return; if (compareText(x, y) < 0) this.parent.set(y, x); else this.parent.set(x, y); }
}

function compareCoordinate(a: Coordinate, b: Coordinate): number { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }
function distance(a: Coordinate, b: Coordinate): number { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function lineLength(coordinates: Coordinate[]): number { let total = 0; for (let index = 1; index < coordinates.length; index += 1) total += distance(coordinates[index - 1]!, coordinates[index]!); return total; }
function endpoint(sourceKey: string, side: "start" | "end"): string { return `${sourceKey}#${side}`; }
function removeZeroLengthSegments(local: Coordinate[], geographic: Coordinate[]): void {
  for (let index = local.length - 1; index > 0; index -= 1) if (distance(local[index]!, local[index - 1]!) <= 1e-9) { local.splice(index, 1); geographic.splice(index, 1); }
  if (local.length < 2) throw new Error("INVALID_CHANNEL_GEOMETRY: fewer than two distinct coordinates");
}

function auditExact(actual: Record<string, number>, expected: Record<string, number>): void {
  const differences = Object.keys(expected).filter((key) => actual[key] !== expected[key]).map((key) => `${key}: expected ${expected[key]}, received ${actual[key]}`);
  if (differences.length) throw new Error(`OPENDRIVE_FIXED_BASELINE_MISMATCH\n${differences.join("\n")}`);
}

export interface CompileInput { sourceBytes: Uint8Array; oracleBytes: Uint8Array; }
export interface CompileResult { artifacts: Record<string, unknown>; files: Record<string, string>; manifest: Record<string, unknown>; }

export function compileOpenDrive(input: CompileInput): CompileResult {
  const sourceHash = sha256(input.sourceBytes); const oracleHash = sha256(input.oracleBytes);
  if (input.sourceBytes.byteLength !== SOURCE_ARTIFACT_BYTES || sourceHash !== SOURCE_ARTIFACT_HASH) throw new Error(`SOURCE_LOCK_MISMATCH: OpenDRIVE expected ${SOURCE_ARTIFACT_BYTES}/${SOURCE_ARTIFACT_HASH}, received ${input.sourceBytes.byteLength}/${sourceHash}`);
  if (oracleHash !== ORACLE_ARTIFACT_HASH) throw new Error(`SOURCE_LOCK_MISMATCH: georeference oracle expected ${ORACLE_ARTIFACT_HASH}, received ${oracleHash}`);
  const document = parseOpenDrive(new TextDecoder("utf-8", { fatal: true }).decode(input.sourceBytes));
  if (document.hasEmbeddedGeoreference) throw new Error("GEOREFERENCE_POLICY_REQUIRED: source contains geoReference; external compatibility transform cannot silently override it");
  const georeference = createAirportGeoreference(); const channels = collectSourceChannels(document); const sourceTransitions = collectSourceTransitions(document, channels); const components = weakComponents(channels, sourceTransitions);
  const activeKeys = new Set(components[0] ?? []); const activeSources = channels.filter((channel) => activeKeys.has(channel.sourceKey)); const quarantined = channels.filter((channel) => !activeKeys.has(channel.sourceKey));
  const activeTransitions = sourceTransitions.filter((transition) => activeKeys.has(transition.fromSourceKey) && activeKeys.has(transition.toSourceKey));
  const regularRoads = document.roads.filter((road) => road.junctionId === "-1"); const connectorRoads = document.roads.filter((road) => road.junctionId !== "-1");
  const primitiveCounts = { line: 0, arc: 0, spiral: 0 }; for (const road of document.roads) for (const geometry of road.geometries) primitiveCounts[geometry.primitive.kind] += 1;
  const counts = {
    roads: document.roads.length, junctions: document.junctions.length, regularRoads: regularRoads.length,
    drivingLaneCandidates: channels.length, physicalRoads: regularRoads.filter((road) => !quarantined.some((channel) => channel.road.id === road.id)).length,
    activeDirectedChannels: activeSources.length, regularDirectedChannels: activeSources.filter((channel) => !channel.isJunctionConnector).length,
    allowedDirectedTransitions: activeTransitions.length, drivableJunctionConnectors: connectorRoads.filter((road) => road.laneSections.some((section) => section.lanes.some((lane) => lane.type === "driving"))).length,
    excludedNonDrivingConnectors: connectorRoads.filter((road) => !road.laneSections.some((section) => section.lanes.some((lane) => lane.type === "driving"))).length,
    quarantinedDrivingChannels: quarantined.length, lineGeometries: primitiveCounts.line, arcGeometries: primitiveCounts.arc, spiralGeometries: primitiveCounts.spiral,
    signals: document.roads.reduce((sum, road) => sum + road.signalCount, 0), objects: document.roads.reduce((sum, road) => sum + road.objectCount, 0)
  };
  auditExact(counts, { roads: 265, junctions: 22, regularRoads: 41, drivingLaneCandidates: 246, physicalRoads: 40, activeDirectedChannels: 244, regularDirectedChannels: 80, allowedDirectedTransitions: 336, drivableJunctionConnectors: 164, excludedNonDrivingConnectors: 60, quarantinedDrivingChannels: 2, lineGeometries: 612, arcGeometries: 366, spiralGeometries: 64, signals: 0, objects: 1 });
  const quarantineRoadIds = [...new Set(quarantined.map((channel) => channel.road.id))].sort(); if (canonicalJson(quarantineRoadIds) !== canonicalJson(["6"])) throw new Error(`OPENDRIVE_FIXED_BASELINE_MISMATCH: quarantine roads ${canonicalJson(quarantineRoadIds)}`);

  const raw = new Map(activeSources.map((source) => { const geometry = compileLaneGeometry(source.road, source.lane, georeference); return [source.sourceKey, { source, ...geometry }]; }));
  const union = new UnionFind(); for (const source of activeSources) { union.add(endpoint(source.sourceKey, "start")); union.add(endpoint(source.sourceKey, "end")); }
  let maximumEndpointGapM = 0;
  for (const transition of activeTransitions) { const from = raw.get(transition.fromSourceKey)!; const to = raw.get(transition.toSourceKey)!; maximumEndpointGapM = Math.max(maximumEndpointGapM, distance(from.localCoordinates.at(-1)!, to.localCoordinates[0]!)); union.union(endpoint(transition.fromSourceKey, "end"), endpoint(transition.toSourceKey, "start")); }
  if (maximumEndpointGapM > 0.001) throw new Error(`OPENDRIVE_ENDPOINT_GAP_EXCEEDED: ${maximumEndpointGapM}`);
  const members = new Map<string, string[]>(); for (const source of activeSources) for (const side of ["start", "end"] as const) { const item = endpoint(source.sourceKey, side); const root = union.find(item); const list = members.get(root) ?? []; list.push(item); members.set(root, list); }
  const nodeByEndpoint = new Map<string, { key: string; local: Coordinate; geographic: Coordinate }>();
  for (const group of members.values()) {
    group.sort(); const points = group.map((item) => { const marker = item.endsWith("#start") ? "start" : "end"; const sourceKey = item.slice(0, -marker.length - 1); const values = raw.get(sourceKey)!.localCoordinates; return marker === "start" ? values[0]! : values.at(-1)!; });
    const local = [...points].sort(compareCoordinate)[0]!; const key = stableKey("nd", { sourceArtifactHash: sourceHash, endpoints: group }); const geographic = [...localToGeographic(local, georeference)] as Coordinate;
    for (const item of group) nodeByEndpoint.set(item, { key, local, geographic });
  }
  const compiled: CompiledChannel[] = activeSources.map((source) => {
    const geometry = raw.get(source.sourceKey)!; const localCoordinates = geometry.localCoordinates.map((point) => [...point] as Coordinate); const coordinates = geometry.coordinates.map((point) => [...point] as Coordinate);
    const startNode = nodeByEndpoint.get(endpoint(source.sourceKey, "start"))!; const endNode = nodeByEndpoint.get(endpoint(source.sourceKey, "end"))!; localCoordinates[0] = startNode.local; localCoordinates[localCoordinates.length - 1] = endNode.local; coordinates[0] = startNode.geographic; coordinates[coordinates.length - 1] = endNode.geographic; removeZeroLengthSegments(localCoordinates, coordinates);
    const geometryContentHash = sha256(canonicalJson(coordinates));
    const identity = { sourceArtifactHash: sourceHash, transformContentHash: georeference.contentHash, compilerVersion: COMPILER_VERSION, roadId: source.road.id, laneSectionStart: source.laneSectionStart, laneId: source.lane.id, sourceLaneGuid: source.lane.sourceGuid ?? null, travelDirection: source.lane.travelDirection, geometryContentHash };
    const channelKey = stableKey("ch", identity); const edgeKey = stableKey("ed", identity); const arcKey = stableKey("ar", identity); const defaultSpeedMmPerS = Math.round((source.road.speedMps ?? 17.8816) * 1000);
    const properties = {
      channelKey, edgeKey, arcKey, sourceNodeKey: startNode.key, targetNodeKey: endNode.key, sourceKey: source.sourceKey,
      sourceRoadId: source.road.id, sourceRoadName: source.road.name, sourceRoadGuid: null, sourceLaneId: source.lane.id, sourceLaneGuid: source.lane.sourceGuid ?? null, laneSectionStart: source.laneSectionStart,
      sourceFeatureReferenceKey: stableReferenceKey({ kind: "OPENDRIVE_ROUTING_CHANNEL", channelKey, sourceArtifactHash: sourceHash }), sourceFeatureVersion: `od-${geometryContentHash.slice(-16)}`, physicalRoadGroupKey: stableKey("prg", { sourceArtifactHash: sourceHash, roadId: source.road.id }),
      roadClass: "XODR_TOWN", sourceRoadType: source.road.roadType ?? null, widthMm: Math.round(geometry.width.minM * 1000), laneCount: 1, oneway: "FORWARD_ONLY", direction: "FORWARD",
      defaultSpeedMmPerS, speedSource: "XODR_UNIFORM_SOURCE", speedConfidence: "LOW", surface: null, surfaceKnowledge: "MISSING_IN_SOURCE", bridge: false, tunnel: false, structureSemantics: "MISSING_IN_SOURCE",
      transitEligible: true, serviceEligible: !source.isJunctionConnector, accessMask: 0,
      accessAttributes: { source: "OPENDRIVE", knowledge: "UNVERIFIED_SOURCE_SEMANTICS" },
      profileConstraints: { widthM: geometry.width, speedSource: "XODR_UNIFORM_SOURCE", unknownDimensions: ["energy", "risk", "surface", "verifiedAccess", "structure"] },
      isJunctionConnector: source.isJunctionConnector, sourceArtifactHash: sourceHash, transformContentHash: georeference.contentHash
    };
    return { source, sourceKey: source.sourceKey, channelKey, edgeKey, arcKey, sourceNodeKey: startNode.key, targetNodeKey: endNode.key, localCoordinates, coordinates, properties };
  }).sort((a, b) => compareText(a.channelKey, b.channelKey));
  const compiledBySource = new Map(compiled.map((channel) => [channel.sourceKey, channel]));
  const transitions = activeTransitions.map((transition) => {
    const from = compiledBySource.get(transition.fromSourceKey)!; const to = compiledBySource.get(transition.toSourceKey)!;
    const ruleKey = stableKey("tr", { sourceArtifactHash: sourceHash, fromArcKey: from.arcKey, viaNodeKey: from.targetNodeKey, toArcKey: to.arcKey });
    const connector = from.source.isJunctionConnector ? from : to.source.isJunctionConnector ? to : undefined;
    return { ruleKey, turnRuleKey: ruleKey, restrictionType: "ALLOWED_ONLY", fromChannelKey: from.channelKey, fromArcKey: from.arcKey, viaNodeKey: from.targetNodeKey, toChannelKey: to.channelKey, toArcKey: to.arcKey, evidence: { ...transition.evidence, sourceArtifactHash: sourceHash, fromSourceKey: transition.fromSourceKey, fromRoadId: from.source.road.id, fromLaneId: from.source.lane.id, fromLaneGuid: from.source.lane.sourceGuid ?? null, fromChannelKey: from.channelKey, toSourceKey: transition.toSourceKey, outRoadId: to.source.road.id, outLaneId: to.source.lane.id, outLaneGuid: to.source.lane.sourceGuid ?? null, outChannelKey: to.channelKey, connectingRoadId: connector?.source.road.id ?? null, junctionId: connector?.source.road.junctionId ?? null } };
  }).sort((a, b) => compareText(a.turnRuleKey, b.turnRuleKey));
  const physicalRoadFeatures: GeoJsonFeature[] = regularRoads.filter((road) => !quarantineRoadIds.includes(road.id)).map((road): GeoJsonFeature => {
    const roadGeometry = compileReferenceGeometry(road, georeference); const roadGeometryHash = sha256(canonicalJson(roadGeometry));
    const roadKey = stableKey("road", { sourceArtifactHash: sourceHash, transformContentHash: georeference.contentHash, roadId: road.id, geometryContentHash: roadGeometryHash });
    const roadChannels = compiled.filter((channel) => channel.source.road.id === road.id); const directions = [...new Set(roadChannels.map((channel) => channel.source.lane.travelDirection))].sort();
    return { type: "Feature", id: roadKey, geometry: { type: "LineString", coordinates: roadGeometry }, properties: { roadKey, sourceRoadId: road.id, sourceRoadName: road.name, sourceRoadGuid: null, sourceFeatureReferenceKey: stableReferenceKey({ kind: "OPENDRIVE_PHYSICAL_ROAD", roadKey, sourceArtifactHash: sourceHash }), sourceFeatureVersion: `od-${roadGeometryHash.slice(-16)}`, physicalRoadGroupKey: stableKey("prg", { sourceArtifactHash: sourceHash, roadId: road.id }), roadClass: "XODR_TOWN", widthM: minimumDrivingRoadWidth(road), widthSource: "XODR_DERIVED_UNVERIFIED", surfaceMaterial: "UNKNOWN", surfaceSource: "MISSING_IN_XODR", oneWay: directions.length === 1, serviceEligible: true, speedMps: road.speedMps ?? 17.8816, speedSource: "XODR_UNIFORM_SOURCE", sourceFormat: "XODR", sourceArtifactHash: sourceHash, conditionClass: "UNKNOWN" } };
  }).sort((a, b) => compareText(a.id, b.id));
  const routingFeatures: GeoJsonFeature[] = compiled.map((channel) => ({ type: "Feature", id: channel.channelKey, geometry: { type: "LineString", coordinates: channel.coordinates }, properties: channel.properties }));
  const identityMap = compiled.map((channel) => ({ channelKey: channel.channelKey, edgeKey: channel.edgeKey, arcKey: channel.arcKey, sourceNodeKey: channel.sourceNodeKey, targetNodeKey: channel.targetNodeKey, sourceKey: channel.sourceKey, sourceRoadId: channel.source.road.id, laneSectionStart: channel.source.laneSectionStart, sourceLaneId: channel.source.lane.id, sourceLaneGuid: channel.source.lane.sourceGuid ?? null, travelDirection: channel.source.lane.travelDirection, physicalRoadGroupKey: channel.properties.physicalRoadGroupKey, sourceFeatureReferenceKey: channel.properties.sourceFeatureReferenceKey, sourceFeatureVersion: channel.properties.sourceFeatureVersion }));
  const buildPolicy = { maximumSegmentLengthM: 1, maximumCurveChordErrorM: 0.05, endpointPolicy: "LEXICOGRAPHIC_MIN_SOURCE_COORDINATE_V1", connectAtGradeIntersections: false, isolationPolicy: "LARGEST_WEAK_COMPONENT_V1", georeferenceConflictPolicy: "FAIL_IF_EMBEDDED_V1" };
  const buildHash = sha256(canonicalJson({ sourceHash, transformContentHash: georeference.contentHash, compilerVersion: COMPILER_VERSION, buildPolicy }));
  const networkContentHash = sha256(canonicalJson({ physicalRoadFeatures, routingFeatures, transitions, identityMap }));
  const datasetReferenceKey = stableReferenceKey({ kind: "OPENDRIVE_NETWORK_DATASET", sourceHash, transformContentHash: georeference.contentHash });
  const datasetVersionKey = stableKey("dsv", { datasetReferenceKey, sourceHash, transformContentHash: georeference.contentHash, networkContentHash }); const graphVersionKey = stableKey("gv", { datasetVersionKey, buildHash, networkContentHash });
  const topologyHash = sha256(canonicalJson({ nodes: [...new Set(compiled.flatMap((channel) => [channel.sourceNodeKey, channel.targetNodeKey]))].sort(), edges: compiled.map((channel) => channel.edgeKey), arcs: compiled.map((channel) => channel.arcKey), transitions: transitions.map((transition) => transition.turnRuleKey) }));
  const admissionPlan = {
    schemaVersion: "1.0", sourceArtifactHash: sourceHash, oracleArtifactHash: oracleHash, transformContentHash: georeference.contentHash, compilerVersion: COMPILER_VERSION,
    buildPolicyVersion: "OPENDRIVE_TASK_NETWORK_BUILD_V1", buildHash, contentHash: networkContentHash, topologyHash, datasetReferenceKey, datasetVersionKey, graphVersionKey,
    counts: { physicalRoads: counts.physicalRoads, activeChannels: counts.activeDirectedChannels, regularChannels: counts.regularDirectedChannels, junctionConnectorChannels: counts.drivableJunctionConnectors, allowedTransitions: counts.allowedDirectedTransitions, excludedNonDrivingConnectors: counts.excludedNonDrivingConnectors, quarantinedChannels: counts.quarantinedDrivingChannels },
    quarantineRoadIds, transform: georeference,
    physicalRoads: physicalRoadFeatures.map((feature) => ({ physicalRoadGroupKey: feature.properties.physicalRoadGroupKey, sourceRoadId: feature.properties.sourceRoadId, coordinates: feature.geometry.coordinates, properties: feature.properties })),
    channels: compiled.map((channel) => ({
      channelKey: channel.channelKey, edgeKey: channel.edgeKey, arcKey: channel.arcKey, sourceNodeKey: channel.sourceNodeKey, targetNodeKey: channel.targetNodeKey, coordinates: channel.coordinates,
      sourceRoadId: channel.source.road.id, sourceLaneId: channel.source.lane.id, laneSectionStart: channel.source.laneSectionStart,
      ...(channel.source.lane.sourceGuid ? { sourceLaneGuid: channel.source.lane.sourceGuid } : {}), travelDirection: channel.source.lane.travelDirection,
      isJunctionConnector: channel.source.isJunctionConnector, physicalRoadGroupKey: channel.properties.physicalRoadGroupKey,
      sourceFeatureReferenceKey: channel.properties.sourceFeatureReferenceKey, sourceFeatureVersion: channel.properties.sourceFeatureVersion,
      lengthMm: Math.max(1, Math.round(lineLength(channel.localCoordinates) * 1000)), width: (channel.properties.profileConstraints as { widthM: unknown }).widthM,
      widthMm: channel.properties.widthMm, defaultSpeedMmPerS: channel.properties.defaultSpeedMmPerS, roadClass: channel.properties.roadClass,
      ...(typeof channel.properties.surface === "string" ? { surface: channel.properties.surface } : {}), isBridge: channel.properties.bridge, isTunnel: channel.properties.tunnel, layerLevel: 0, oneway: channel.properties.oneway,
      accessAttributes: channel.properties.accessAttributes, transitEligible: channel.properties.transitEligible, serviceEligible: channel.properties.serviceEligible,
      accessMask: channel.properties.accessMask, profileConstraints: channel.properties.profileConstraints, properties: channel.properties
    })), transitions
  };
  const quarantineArtifact = { schemaVersion: "1.0", sourceArtifactHash: sourceHash, roadIds: quarantineRoadIds, channels: quarantined.map((channel) => ({ sourceKey: channel.sourceKey, roadId: channel.road.id, laneId: channel.lane.id, sourceLaneGuid: channel.lane.sourceGuid ?? null, reasons: ["ISOLATED_FROM_MAIN_COMPONENT", "UNLINKED_ROAD", "OVERLAPPING_SOURCE_CANDIDATE"] })) };
  const compileReport = { schemaVersion: "1.0", status: "PASS", source: { bytes: input.sourceBytes.byteLength, hash: sourceHash, openDriveVersion: document.version, oracleArtifactHash: oracleHash }, georeference, identities: { buildHash, contentHash: networkContentHash, topologyHash, datasetReferenceKey, datasetVersionKey, graphVersionKey }, counts, topology: { weakComponents: components.map((component) => component.length), allActiveChannelsInOneWeakComponent: true, referenceIntegrityIssues: 0, maximumSourceEndpointGapM: maximumEndpointGapM }, geometry: { primitiveCounts, maximumSegmentLengthM: 1, curveChordErrorPolicyM: 0.05, laneOffsetRecordsEvaluated: document.roads.reduce((sum, road) => sum + road.laneOffsets.length, 0), laneWidthRecordsEvaluated: document.roads.reduce((sum, road) => sum + road.laneSections.flatMap((section) => section.lanes).reduce((laneSum, lane) => laneSum + lane.widths.length, 0), 0), elevationRecordsEvaluated: document.roads.reduce((sum, road) => sum + road.elevations.length, 0), lateralProfilePresentButNotApplied: document.roads.filter((road) => road.hasLateralProfile).length, elevationProfileApplied: true }, limitations: ["UNVERIFIED_COMPATIBILITY_TRANSFORM", "NO_SURVEY_ACCURACY_CLAIM", "NO_FIELD_VERIFICATION_OF_SPEED_WIDTH_SURFACE_STRUCTURE_OR_ACCESS", "LATERAL_PROFILE_SUPERELEVATION_SHAPE_AND_LANE_HEIGHT_NOT_APPLIED", "SOURCE_OBJECT_DASHED_CROSSWALK_NOT_ADOPTED"] };
  const artifacts: Record<string, unknown> = {
    "physical-roads.geojson": { type: "FeatureCollection", features: physicalRoadFeatures }, "routing-channels.geojson": { type: "FeatureCollection", features: routingFeatures },
    "allowed-transitions.json": { schemaVersion: "1.0", sourceArtifactHash: sourceHash, transitions }, "identity-map.json": { schemaVersion: "1.0", sourceArtifactHash: sourceHash, identities: identityMap },
    "quarantine.json": quarantineArtifact, "compile-report.json": compileReport, "admission-plan.json": admissionPlan
  };
  const artifactHashes = Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, sha256(`${JSON.stringify(value, null, 2)}\n`)]));
  const manifest = { schemaVersion: "1.0", compilerVersion: COMPILER_VERSION, sourceArtifact: { mediaType: "application/x-opendrive+xml", bytes: input.sourceBytes.byteLength, hash: sourceHash }, georeference, buildPolicy, buildHash, contentHash: networkContentHash, topologyHash, datasetReferenceKey, datasetVersionKey, graphVersionKey, counts, artifactHashes };
  artifacts["compile-manifest.json"] = manifest;
  const files = Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, `${JSON.stringify(value, null, 2)}\n`]));
  return { artifacts, files, manifest };
}

export async function compileOpenDrivePaths(sourcePath: string, oraclePath: string): Promise<CompileResult> {
  const [sourceBytes, oracleBytes] = await Promise.all([readFile(sourcePath), readFile(oraclePath)]); return compileOpenDrive({ sourceBytes, oracleBytes });
}
