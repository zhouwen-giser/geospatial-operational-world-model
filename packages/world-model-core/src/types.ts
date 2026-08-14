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
  timeSolutionId?: string;
  positionMeasurementId?: string;
  projectionPolicyVersion?: string;
  uncertainty?: PositionUncertainty;
  observedAt: string;
  receivedAt: string;
}

export interface WorldObject {
  id: string;
  dataScopeKey?: string;
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
  schemaVersion: "1.0" | "1.2";
}

export const OBSERVATION_ORIGIN_KINDS = [
  "PHYSICAL_SENSOR", "DERIVED_ALGORITHM", "MANUAL", "SIMULATION", "EXTERNAL"
] as const;

export type ObservationOriginKind = (typeof OBSERVATION_ORIGIN_KINDS)[number];
export type MeasurementStage = "PARSED_NATIVE" | "NORMALIZED" | "FUSED_DERIVED";
export type MeasurementResultKind = "POSITION" | "NUMERIC" | "VECTOR" | "GEOMETRY_SUPPORT";
export type PositionAccuracyModel = "HARD_RADIUS" | "STDDEV" | "COVARIANCE" | "INTERVAL" | "UNKNOWN";

export interface PhenomenonTimeWindow {
  start: string;
  end: string;
}

export interface CanonicalTimeSolutionInput {
  phenomenonTimeEstimate: string;
  phenomenonTimeWindow: PhenomenonTimeWindow;
  uncertaintySeconds: number;
  correctionMethod: string;
  clockModelVersion: string;
  clockDomain?: string;
  clockOffsetSeconds?: number;
  clockDriftPpm?: number;
  clockResidualSigmaMs?: number;
  clockEstimationMethod?: string;
  clockCalibrationReference?: string;
  supersedesClockModelId?: string;
  sourceTime?: string;
  sourceTimeRaw?: string;
  sourceTimeTicks?: string;
  resultTime?: string;
  sourceEmittedTime?: string;
  upstreamReceivedTime?: string;
  processedTime?: string;
  exposureOrScanDurationMs?: number;
  supersedesTimeSolutionId?: string;
}

export interface PositionUncertainty {
  model: PositionAccuracyModel;
  unit?: "m" | "m2";
  horizontalValue?: number;
  confidenceLevel?: number;
  covariance?: [[number, number], [number, number]];
}

export interface CanonicalMeasurementInput {
  measurementId?: string;
  measurementKey: string;
  measurementStage: MeasurementStage;
  observedProperty: string;
  resultKind: MeasurementResultKind;
  analysisSpaceKey?: string;
  position?: { x: number; y: number; srid: number };
  sourceGeometry?: PointGeometry;
  altitudeM?: number;
  verticalDatum?: string;
  uncertainty?: PositionUncertainty;
  scalarValue?: number;
  valueUnit?: string;
  vectorValue?: number[];
  nativeFrame?: string;
  measurementModel: string;
  measurementModelVersion: string;
  calibrationVersion?: string;
  algorithmConfidence?: number;
  qualityScore?: number;
  qualityFlags: string[];
  continuityToken?: string;
  manualCutBefore?: boolean;
  attributes: Record<string, unknown>;
}

export interface ObservationAssertionInput {
  assertionKind: string;
  label: string;
  probability?: number;
  calibrationVersion?: string;
  basisReference: string;
  inputMeasurementKeys: string[];
}

/** Public v1.2 command. receivedAt is deliberately absent: the HTTP boundary owns it. */
export interface CanonicalObservationInput {
  schemaVersion: "1.2";
  observationId: string;
  dataScopeKey: string;
  sourceRecordKey: string;
  sourceRevisionNo: number;
  supersedesObservationId?: string;
  originKind: ObservationOriginKind;
  observer: ObserverRef;
  subject: SubjectRef;
  sourceLocalTargetId?: string;
  trackerSessionId?: string;
  observationType: string;
  source: string;
  datastreamKey: string;
  producerPipelineKey: string;
  rawReference: string;
  correlationId?: string;
  qualityFlags: string[];
  metadata: Record<string, unknown>;
  timeSolution: CanonicalTimeSolutionInput;
  measurements: CanonicalMeasurementInput[];
  assertions: ObservationAssertionInput[];
  entityBindingStatus: "DECLARED" | "CANDIDATE" | "CONFIRMED";
}

/** Internal immutable bundle produced by both v1.1 compatibility and v1.2 inputs. */
export interface CanonicalObservationBundle {
  envelope: ObservationEnvelope;
  dataScopeKey: string;
  sourceRecordKey: string;
  sourceRevisionNo: number;
  supersedesObservationId?: string;
  originKind: ObservationOriginKind;
  sourceLocalTargetId: string;
  trackerSessionId?: string;
  datastreamKey: string;
  producerPipelineKey: string;
  rawReference: string;
  payloadHash: string;
  qualityFlags: string[];
  timeSolution: CanonicalTimeSolutionInput;
  measurements: CanonicalMeasurementInput[];
  assertions: ObservationAssertionInput[];
  entityBindingStatus: "DECLARED" | "CANDIDATE" | "CONFIRMED";
  compatibilityInputVersion?: "1.0";
}

export interface MobilityTrajectory {
  trackletId: string;
  trackletVersionId: string;
  entityId?: string;
  source: string;
  sourceLocalTargetId: string;
  trackerSessionKey: string;
  analysisSpaceKey: string;
  version: number;
  state: "PROVISIONAL" | "SEALED" | "CONFLICTED";
  sequenceCount: number;
  sampleCount: number;
  startTime: string;
  endTime: string;
  trajectory: Record<string, unknown>;
  gaps: Array<{
    gapNo: number;
    start: string;
    end: string;
    bounds: "()";
    reasonCodes: string[];
    observabilityState: string;
  }>;
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
  reason: "new" | "newer" | "higher-priority" | "higher-confidence" | "tie-break" | "out-of-order" | "superseded" | "candidate-unresolved";
}

export interface CurrentProjection {
  observedAt: string;
  confidence: number;
  source: string;
  sourceObservationId: string;
}
