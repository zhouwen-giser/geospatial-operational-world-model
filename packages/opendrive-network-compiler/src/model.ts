export type Polynomial = { s: number; a: number; b: number; c: number; d: number };
export type PlanGeometry = {
  s: number; x: number; y: number; heading: number; length: number;
  primitive: { kind: "line" } | { kind: "arc"; curvature: number } | { kind: "spiral"; curvatureStart: number; curvatureEnd: number };
};
export type RoadLink = { elementType: "road" | "junction"; elementId: string; contactPoint?: "start" | "end" };
export type Lane = {
  id: number; type: string; sourceGuid?: string; travelDirection: "forward" | "backward" | "undirected";
  widths: Polynomial[]; predecessorId?: number; successorId?: number;
};
export type LaneSection = { s: number; lanes: Lane[] };
export type Road = {
  id: string; name: string; length: number; junctionId: string; roadType?: string; speedMps?: number;
  predecessor?: RoadLink; successor?: RoadLink; geometries: PlanGeometry[]; elevations: Polynomial[];
  laneOffsets: Polynomial[]; laneSections: LaneSection[]; hasLateralProfile: boolean; objectCount: number; signalCount: number;
};
export type JunctionLaneLink = { fromLaneId: number; toLaneId: number };
export type JunctionConnection = { id: string; incomingRoadId: string; connectingRoadId: string; contactPoint: "start" | "end"; laneLinks: JunctionLaneLink[] };
export type Junction = { id: string; connections: JunctionConnection[] };
export type OpenDriveDocument = { version: string; hasEmbeddedGeoreference: boolean; roads: Road[]; junctions: Junction[] };

export type LocalPoint = { x: number; y: number; z: number; heading: number };
export type ChannelGeometry = {
  localCoordinates: Array<[number, number, number]>;
  coordinates: Array<[number, number, number]>;
  width: { minM: number; maxM: number; meanM: number };
};
