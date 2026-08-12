export const WORLD_OBJECT_TYPES = [
  "Agent", "Device", "Sensor", "Camera", "Vehicle", "UGV", "UAV",
  "Facility", "Road", "RoadSegment", "Zone", "AOI", "Geofence",
  "Mission", "Task", "Incident", "Alert", "Route", "Observation", "Situation"
] as const;

export type WorldObjectType = (typeof WORLD_OBJECT_TYPES)[number] | (string & {});

export const PERSISTED_RELATIONS = [
  "connectedTo", "assignedTo", "executing", "observedBy", "observes",
  "affects", "coveredBy", "belongsTo"
] as const;

export const COMPUTED_RELATIONS = ["locatedIn", "locatedOn", "near", "contains"] as const;

export type RelationType =
  | (typeof PERSISTED_RELATIONS)[number]
  | (typeof COMPUTED_RELATIONS)[number]
  | (string & {});

export interface PointGeometry {
  type: "Point";
  coordinates: [number, number] | [number, number, number];
}

export interface LineStringGeometry {
  type: "LineString";
  coordinates: Array<[number, number] | [number, number, number]>;
}

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Array<Array<[number, number] | [number, number, number]>>;
}

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Array<Array<Array<[number, number] | [number, number, number]>>>;
}

export type Geometry = PointGeometry | LineStringGeometry | PolygonGeometry | MultiPolygonGeometry;

export interface H3Projection {
  r7?: string;
  r8?: string;
  r9?: string;
  r10?: string;
}

export interface WorldRelation {
  id?: string;
  relationType: RelationType;
  fromObjectId: string;
  toObjectId: string;
  persisted: boolean;
  properties?: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
}

export interface WorldStateProvenance {
  confidence: number;
  source: string;
  sourceObservationId: string;
  observedAt: string;
  receivedAt: string;
}

export interface WorldObject {
  id: string;
  type: WorldObjectType;
  subtype?: string;
  geometry?: Geometry;
  h3?: H3Projection;
  state: Record<string, unknown>;
  properties: Record<string, unknown>;
  relations?: WorldRelation[];
  confidence: number;
  observedAt?: string;
  updatedAt: string;
  version: number;
  provenance?: WorldStateProvenance;
  freshnessMs?: number;
  stale?: boolean;
}

export interface ObserverRef {
  type: WorldObjectType;
  id: string;
}

export interface SubjectRef {
  type: WorldObjectType;
  id: string;
}

export interface ObservationEnvelope {
  observationId: string;
  observer: ObserverRef;
  subject: SubjectRef;
  observationType: string;
  geometry?: Geometry;
  value: Record<string, unknown>;
  confidence: number;
  observedAt: string;
  receivedAt: string;
  source: string;
  correlationId: string;
  metadata: Record<string, unknown>;
  schemaVersion: "1.0";
}

export type ObservationStatus =
  | "accepted"
  | "duplicate"
  | "invalid"
  | "late"
  | "stale"
  | "superseded"
  | "projected";

export const WORLD_EVENT_TYPES = [
  "ObservationReceived", "ObjectCreated", "ObjectUpdated", "ObjectMoved",
  "ObjectStateChanged", "ObjectEnteredArea", "ObjectExitedArea",
  "ObjectNearObject", "SituationCreated", "SituationUpdated",
  "CoverageChanged", "TrajectoryUpdated"
] as const;

export type WorldEventType = (typeof WORLD_EVENT_TYPES)[number] | (string & {});

export interface WorldEvent {
  eventId: string;
  eventType: WorldEventType;
  subject: SubjectRef;
  timestamp: string;
  geometry?: Geometry;
  worldVersion: number;
  correlationId: string;
  causationId: string;
  payload: Record<string, unknown>;
  schemaVersion: "1.0";
}

export interface TrajectoryPoint {
  entityId: string;
  timestamp: string;
  geometry: PointGeometry;
  latitude: number;
  longitude: number;
  altitude?: number;
  heading?: number;
  speed?: number;
  state: Record<string, unknown>;
  source: string;
  confidence: number;
  observationId: string;
}

export interface SituationMetrics {
  agentCount: number;
  vehicleCount: number;
  sensorCount: number;
  incidentCount: number;
  observationCount: number;
  riskScore: number;
  coverageScore: number;
  activityScore: number;
  freshnessScore: number;
}

export interface SituationCell {
  h3Index: string;
  resolution: number;
  metrics: SituationMetrics;
  updatedAt: string;
  worldVersion: number;
  boundary?: PolygonGeometry;
}

export interface AgentResponseContext {
  worldVersion: number;
  dataFreshnessMs: number | null;
  queryTimeMs: number;
  confidence?: number;
  provenance?: Array<{ source: string; observationId: string; observedAt: string }>;
}

export interface AgentToolResponse<T> {
  summary: Record<string, unknown>;
  facts: T;
  context: AgentResponseContext;
}

export interface ProjectionDecision {
  apply: boolean;
  reason: "new" | "newer" | "higher-priority" | "higher-confidence" | "tie-break" | "out-of-order" | "superseded";
}

export interface CurrentProjection {
  observedAt: string;
  confidence: number;
  source: string;
  sourceObservationId: string;
}
