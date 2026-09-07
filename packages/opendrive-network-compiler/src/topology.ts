import { compareText } from "./canonical.js";
import type { Lane, OpenDriveDocument, Road } from "./model.js";

export type SourceChannel = { sourceKey: string; road: Road; lane: Lane; laneSectionStart: number; isJunctionConnector: boolean };
export type SourceTransition = { fromSourceKey: string; toSourceKey: string; evidence: Record<string, unknown> };

export function sourceChannelKey(roadId: string, laneSectionStart: number, laneId: number): string { return `road:${roadId}/section:${laneSectionStart.toFixed(9)}/lane:${laneId}`; }
function laneAtBoundary(road: Road, laneId: number, side: "start" | "end"): Lane | undefined { const section = side === "start" ? road.laneSections[0] : road.laneSections.at(-1); return section?.lanes.find((lane) => lane.id === laneId && lane.type === "driving"); }
function channelFor(channels: Map<string, SourceChannel>, road: Road, lane: Lane): SourceChannel | undefined { const section = road.laneSections.find((item) => item.lanes.includes(lane)); return section && channels.get(sourceChannelKey(road.id, section.s, lane.id)); }

export function collectSourceChannels(document: OpenDriveDocument): SourceChannel[] {
  return document.roads.flatMap((road) => road.laneSections.flatMap((section) => section.lanes.filter((lane) => lane.type === "driving").map((lane) => ({ sourceKey: sourceChannelKey(road.id, section.s, lane.id), road, lane, laneSectionStart: section.s, isJunctionConnector: road.junctionId !== "-1" })))).sort((a, b) => compareText(a.sourceKey, b.sourceKey));
}

export function collectSourceTransitions(document: OpenDriveDocument, channels: SourceChannel[]): SourceTransition[] {
  const roads = new Map(document.roads.map((road) => [road.id, road])); const byKey = new Map(channels.map((channel) => [channel.sourceKey, channel])); const result: SourceTransition[] = [];
  const add = (from: SourceChannel | undefined, to: SourceChannel | undefined, evidence: Record<string, unknown>) => { if (from && to) result.push({ fromSourceKey: from.sourceKey, toSourceKey: to.sourceKey, evidence }); };
  // Junction laneLink is explicitly directed incoming-road -> connecting-road.
  for (const junction of document.junctions) for (const connection of junction.connections) {
    const incoming = roads.get(connection.incomingRoadId); const connecting = roads.get(connection.connectingRoadId); if (!incoming || !connecting) throw new Error("OPENDRIVE_REFERENCE_INTEGRITY: unknown junction road");
    for (const link of connection.laneLinks) {
      const incomingLane = incoming.laneSections.flatMap((section) => section.lanes).find((lane) => lane.id === link.fromLaneId && lane.type === "driving");
      const connectingLane = laneAtBoundary(connecting, link.toLaneId, connection.contactPoint);
      add(incomingLane && channelFor(byKey, incoming, incomingLane), connectingLane && channelFor(byKey, connecting, connectingLane), { relationKind: "JUNCTION_LANE_LINK", junctionId: junction.id, connectionId: connection.id, incomingRoadId: incoming.id, connectingRoadId: connecting.id, fromLaneId: link.fromLaneId, toLaneId: link.toLaneId });
    }
  }
  // Every directed lane's downstream road/lane link supplies connector exits and direct road transitions.
  for (const from of channels) {
    const boundary = from.lane.travelDirection === "forward" ? "successor" : from.lane.travelDirection === "backward" ? "predecessor" : undefined;
    if (!boundary) throw new Error(`INVALID_OPENDRIVE: driving lane ${from.sourceKey} is undirected`);
    const roadLink = from.road[boundary]; const laneId = boundary === "successor" ? from.lane.successorId : from.lane.predecessorId;
    if (!roadLink || roadLink.elementType !== "road" || laneId === undefined) continue;
    const targetRoad = roads.get(roadLink.elementId); if (!targetRoad) throw new Error(`OPENDRIVE_REFERENCE_INTEGRITY: unknown road ${roadLink.elementId}`);
    const contactPoint = roadLink.contactPoint; if (!contactPoint) throw new Error(`OPENDRIVE_REFERENCE_INTEGRITY: road link ${from.road.id}/${boundary} lacks contactPoint`);
    const targetLane = laneAtBoundary(targetRoad, laneId, contactPoint);
    add(from, targetLane && channelFor(byKey, targetRoad, targetLane), { relationKind: from.isJunctionConnector ? "CONNECTING_ROAD_EXIT" : "ROAD_LANE_LINK", fromRoadId: from.road.id, outRoadId: targetRoad.id, fromLaneId: from.lane.id, toLaneId: laneId, contactPoint });
  }
  const unique = new Map(result.map((item) => [`${item.fromSourceKey}->${item.toSourceKey}`, item]));
  return [...unique.values()].sort((a, b) => compareText(`${a.fromSourceKey}->${a.toSourceKey}`, `${b.fromSourceKey}->${b.toSourceKey}`));
}

export function weakComponents(channels: SourceChannel[], transitions: SourceTransition[]): string[][] {
  const adjacent = new Map(channels.map((channel) => [channel.sourceKey, new Set<string>()]));
  for (const transition of transitions) { adjacent.get(transition.fromSourceKey)?.add(transition.toSourceKey); adjacent.get(transition.toSourceKey)?.add(transition.fromSourceKey); }
  const seen = new Set<string>(); const result: string[][] = [];
  for (const channel of channels) { if (seen.has(channel.sourceKey)) continue; const component: string[] = []; const queue = [channel.sourceKey]; seen.add(channel.sourceKey); while (queue.length) { const current = queue.shift()!; component.push(current); for (const next of adjacent.get(current) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); } } result.push(component.sort()); }
  return result.sort((a, b) => b.length - a.length || compareText(a[0]!, b[0]!));
}
