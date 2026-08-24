import { sha256 } from "./canonical.js";
import { networkArcKey, networkEdgeKey, networkNodeKey } from "./identity.js";
import type {
  BuiltNetworkArc,
  BuiltNetworkEdge,
  BuiltNetworkNode,
  BuiltNetworkTopology,
  MaterializedNetworkBuild,
  MaterializedNetworkFeature,
  NormalizedPosition
} from "./types.js";

interface FeaturePolicy {
  readonly roadClass: string;
  readonly surface?: string;
  readonly isBridge: boolean;
  readonly isTunnel: boolean;
  readonly layerLevel: number;
  readonly oneway: BuiltNetworkEdge["oneway"];
  readonly defaultSpeedMmPerS: number;
  readonly topologyIdentity: string;
}

interface Segment {
  readonly feature: MaterializedNetworkFeature;
  readonly policy: FeaturePolicy;
  readonly segmentIndex: number;
  readonly start: NormalizedPosition;
  readonly end: NormalizedPosition;
  readonly featureOffsetMm: number;
  readonly segmentLengthMm: number;
  readonly featureLengthMm: number;
  readonly splits: Array<{ t: number; position: NormalizedPosition }>;
}

function booleanProperty(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "yes" || value === "true";
}

function integerProperty(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function positiveIntegerProperty(value: unknown, fallback: number): number {
  const parsed = integerProperty(value, fallback);
  if (parsed <= 0) throw new Error("network fixed-point property must be positive");
  return parsed;
}

function featurePolicy(feature: MaterializedNetworkFeature): FeaturePolicy {
  const properties = feature.properties;
  const isBridge = booleanProperty(properties.bridge);
  const isTunnel = booleanProperty(properties.tunnel);
  if (isBridge && isTunnel) throw new Error("network feature cannot be bridge and tunnel");
  const layerLevel = integerProperty(properties.layerLevel ?? properties.layer, 0);
  if (layerLevel < -100 || layerLevel > 100) throw new Error("network feature layer is outside policy bounds");
  const rawOneway = properties.oneway;
  const oneway: BuiltNetworkEdge["oneway"] = rawOneway === -1 || rawOneway === "-1" || rawOneway === "reverse"
    ? "REVERSE_ONLY"
    : booleanProperty(rawOneway) || rawOneway === "forward" ? "FORWARD_ONLY" : "BIDIRECTIONAL";
  const policy = {
    roadClass: typeof properties.roadClass === "string" ? properties.roadClass : "UNCLASSIFIED",
    ...(typeof properties.surface === "string" ? { surface: properties.surface } : {}),
    isBridge,
    isTunnel,
    layerLevel,
    oneway,
    defaultSpeedMmPerS: positiveIntegerProperty(properties.defaultSpeedMmPerS, 13_889)
  };
  return { ...policy, topologyIdentity: `layer=${layerLevel};bridge=${isBridge};tunnel=${isTunnel}` };
}

function distanceMm(left: NormalizedPosition, right: NormalizedPosition): number {
  const latitudeRadians = ((left.latitudeNanodegrees + right.latitudeNanodegrees) / 2 / 1_000_000_000) * Math.PI / 180;
  const dx = (right.longitudeNanodegrees - left.longitudeNanodegrees) / 1_000_000_000 * 111_320_000 * Math.cos(latitudeRadians);
  const dy = (right.latitudeNanodegrees - left.latitudeNanodegrees) / 1_000_000_000 * 110_574_000;
  const dz = right.elevationMm - left.elevationMm;
  const length = Math.round(Math.hypot(dx, dy, dz));
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error("network segment length is invalid");
  return length;
}

function positionAt(segment: Pick<Segment, "start" | "end">, t: number): NormalizedPosition {
  const interpolate = (left: number, right: number): number => Math.round(left + (right - left) * t);
  return {
    longitudeNanodegrees: interpolate(segment.start.longitudeNanodegrees, segment.end.longitudeNanodegrees),
    latitudeNanodegrees: interpolate(segment.start.latitudeNanodegrees, segment.end.latitudeNanodegrees),
    elevationMm: interpolate(segment.start.elevationMm, segment.end.elevationMm)
  };
}

function intersection(left: Segment, right: Segment): { leftT: number; rightT: number } | null {
  const ax = left.start.longitudeNanodegrees;
  const ay = left.start.latitudeNanodegrees;
  const bx = left.end.longitudeNanodegrees;
  const by = left.end.latitudeNanodegrees;
  const cx = right.start.longitudeNanodegrees;
  const cy = right.start.latitudeNanodegrees;
  const dx = right.end.longitudeNanodegrees;
  const dy = right.end.latitudeNanodegrees;
  const denominator = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (denominator === 0) return null;
  const leftT = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denominator;
  const rightT = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denominator;
  const epsilon = 1e-12;
  return leftT >= -epsilon && leftT <= 1 + epsilon && rightT >= -epsilon && rightT <= 1 + epsilon
    ? { leftT: Math.max(0, Math.min(1, leftT)), rightT: Math.max(0, Math.min(1, rightT)) }
    : null;
}

function addSplit(segment: Segment, t: number): void {
  if (!segment.splits.some((split) => Math.abs(split.t - t) < 1e-12)) {
    segment.splits.push({ t, position: positionAt(segment, t) });
  }
}

function buildSegments(feature: MaterializedNetworkFeature): Segment[] {
  const policy = featurePolicy(feature);
  const lengths = feature.positions.slice(1).map((position, index) => distanceMm(feature.positions[index]!, position));
  const featureLengthMm = lengths.reduce((sum, length) => sum + length, 0);
  let featureOffsetMm = 0;
  return lengths.map((segmentLengthMm, segmentIndex) => {
    const start = feature.positions[segmentIndex]!;
    const end = feature.positions[segmentIndex + 1]!;
    const segment: Segment = {
      feature,
      policy,
      segmentIndex,
      start,
      end,
      featureOffsetMm,
      segmentLengthMm,
      featureLengthMm,
      splits: [{ t: 0, position: start }, { t: 1, position: end }]
    };
    featureOffsetMm += segmentLengthMm;
    return segment;
  });
}

function ppm(offsetMm: number, featureLengthMm: number): number {
  return Math.max(0, Math.min(1_000_000, Math.round(offsetMm / featureLengthMm * 1_000_000)));
}

export function buildNetworkTopology(build: MaterializedNetworkBuild): BuiltNetworkTopology {
  const segments = build.features.flatMap(buildSegments);
  if (build.buildPolicy.connectAtGradeIntersections) {
    for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
      const left = segments[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
        const right = segments[rightIndex]!;
        if (left.feature.featureReferenceKey === right.feature.featureReferenceKey ||
            left.policy.topologyIdentity !== right.policy.topologyIdentity) continue;
        const crossing = intersection(left, right);
        if (!crossing) continue;
        addSplit(left, crossing.leftT);
        addSplit(right, crossing.rightT);
      }
    }
  }

  const nodes = new Map<string, BuiltNetworkNode>();
  const edges: BuiltNetworkEdge[] = [];
  const arcs: BuiltNetworkArc[] = [];
  for (const segment of segments) {
    segment.splits.sort((left, right) => left.t - right.t);
    for (let index = 0; index < segment.splits.length - 1; index += 1) {
      const start = segment.splits[index]!;
      const end = segment.splits[index + 1]!;
      if (end.t - start.t < 1e-12) continue;
      const sourceNodeKey = networkNodeKey(build.buildPolicy.version, start.position, segment.policy.topologyIdentity);
      const targetNodeKey = networkNodeKey(build.buildPolicy.version, end.position, segment.policy.topologyIdentity);
      nodes.set(sourceNodeKey, { nodeKey: sourceNodeKey, position: start.position, topologyIdentity: segment.policy.topologyIdentity });
      nodes.set(targetNodeKey, { nodeKey: targetNodeKey, position: end.position, topologyIdentity: segment.policy.topologyIdentity });
      const splitStartPpm = ppm(segment.featureOffsetMm + segment.segmentLengthMm * start.t, segment.featureLengthMm);
      const splitEndPpm = ppm(segment.featureOffsetMm + segment.segmentLengthMm * end.t, segment.featureLengthMm);
      if (splitEndPpm <= splitStartPpm) throw new Error("network split interval collapsed after fixed-point conversion");
      const edgeKey = networkEdgeKey({
        buildPolicyVersion: build.buildPolicy.version,
        sourceFeatureReferenceKey: segment.feature.featureReferenceKey,
        sourceFeatureVersion: segment.feature.featureVersion,
        splitStartPpm,
        splitEndPpm,
        sourceNodeKey,
        targetNodeKey
      });
      const positions = [start.position, end.position] as const;
      const lengthMm = distanceMm(start.position, end.position);
      const edge: BuiltNetworkEdge = {
        edgeKey,
        sourceFeatureReferenceKey: segment.feature.featureReferenceKey,
        sourceFeatureVersion: segment.feature.featureVersion,
        sourceNodeKey,
        targetNodeKey,
        splitStartPpm,
        splitEndPpm,
        positions,
        lengthMm,
        roadClass: segment.policy.roadClass,
        ...(segment.policy.surface === undefined ? {} : { surface: segment.policy.surface }),
        isBridge: segment.policy.isBridge,
        isTunnel: segment.policy.isTunnel,
        layerLevel: segment.policy.layerLevel,
        oneway: segment.policy.oneway
      };
      edges.push(edge);
      if (edge.oneway !== "REVERSE_ONLY") {
        arcs.push({
          arcKey: networkArcKey(edgeKey, "FORWARD"), edgeKey, sourceNodeKey, targetNodeKey,
          direction: "FORWARD", positions, lengthMm, defaultSpeedMmPerS: segment.policy.defaultSpeedMmPerS
        });
      }
      if (edge.oneway !== "FORWARD_ONLY") {
        arcs.push({
          arcKey: networkArcKey(edgeKey, "REVERSE"), edgeKey, sourceNodeKey: targetNodeKey, targetNodeKey: sourceNodeKey,
          direction: "REVERSE", positions: [...positions].reverse(), lengthMm,
          defaultSpeedMmPerS: segment.policy.defaultSpeedMmPerS
        });
      }
    }
  }

  const sortedNodes = [...nodes.values()].sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
  edges.sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
  arcs.sort((left, right) => left.arcKey.localeCompare(right.arcKey));
  const topologyHash = sha256({
    nodes: sortedNodes.map(({ nodeKey, position, topologyIdentity }) => ({ nodeKey, position, topologyIdentity })),
    edges: edges.map(({ edgeKey, sourceNodeKey, targetNodeKey, sourceFeatureReferenceKey, splitStartPpm, splitEndPpm }) => ({
      edgeKey, sourceNodeKey, targetNodeKey, sourceFeatureReferenceKey, splitStartPpm, splitEndPpm
    })),
    arcs: arcs.map(({ arcKey, edgeKey, sourceNodeKey, targetNodeKey, direction }) => ({ arcKey, edgeKey, sourceNodeKey, targetNodeKey, direction }))
  });
  const contentHash = sha256({ topologyHash, nodes: sortedNodes, edges, arcs });
  return { nodes: sortedNodes, edges, arcs, topologyHash, contentHash, diagnostics: [] };
}
