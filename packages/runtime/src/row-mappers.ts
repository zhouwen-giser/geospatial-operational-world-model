import type {
  Geometry,
  ObservationEnvelope,
  PositionUncertainty,
  SituationCell,
  TrajectoryPoint,
  WorldEvent,
  WorldObject,
  WorldRelation
} from "../../world-model-core/src/types.js";
import { freshness } from "../../observation-model/src/fusion.js";
import { h3Boundary } from "../../h3-situation/src/h3.js";

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function iso(value: unknown): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function mapWorldObject(row: Record<string, unknown>, staleAfterMs: number, relations?: WorldRelation[]): WorldObject {
  const observedAt = iso(row.observed_at);
  const freshnessResult = freshness(observedAt, staleAfterMs);
  const state = json<Record<string, unknown>>(row.state, {});
  const uncertainty = json<Record<string,unknown>>(row.uncertainty_summary, {});
  let geometry = row.geometry_json ? json<Geometry>(row.geometry_json, undefined as never) : undefined;
  const position = state.position as Record<string, unknown> | undefined;
  if (geometry?.type === "Point" && typeof position?.altitude === "number") {
    geometry = { type: "Point", coordinates: [geometry.coordinates[0], geometry.coordinates[1], position.altitude] };
  }
  return {
    id: String(row.id),
    ...(row.data_scope_key ? { dataScopeKey: String(row.data_scope_key) } : {}),
    type: String(row.object_type),
    ...(row.subtype ? { subtype: String(row.subtype) } : {}),
    ...(geometry ? { geometry } : {}),
    h3: {
      ...(row.h3_r7 ? { r7: String(row.h3_r7) } : {}),
      ...(row.h3_r8 ? { r8: String(row.h3_r8) } : {}),
      ...(row.h3_r9 ? { r9: String(row.h3_r9) } : {}),
      ...(row.h3_r10 ? { r10: String(row.h3_r10) } : {})
    },
    state,
    properties: json<Record<string, unknown>>(row.properties, {}),
    ...(relations ? { relations } : {}),
    confidence: Number(row.confidence ?? 1),
    ...(observedAt ? { observedAt } : {}),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    version: Number(row.version ?? 0),
    ...(row.source_observation_id && observedAt
      ? {
          provenance: {
            confidence: Number(row.confidence),
            source: String(row.source),
            sourceObservationId: String(row.source_observation_id),
            ...(row.time_solution_id ? { timeSolutionId: String(row.time_solution_id) } : {}),
            ...(row.position_measurement_id ? { positionMeasurementId: String(row.position_measurement_id) } : {}),
            ...(row.projection_policy_version ? { projectionPolicyVersion: String(row.projection_policy_version) } : {}),
            ...(typeof uncertainty.model === "string"
              ? { uncertainty: uncertainty as unknown as PositionUncertainty }
              : {}),
            observedAt,
            receivedAt: iso(row.received_at) ?? observedAt
          }
        }
      : {}),
    ...(freshnessResult.freshnessMs === null ? {} : { freshnessMs: freshnessResult.freshnessMs }),
    stale: freshnessResult.stale
  };
}

export function mapRelation(row: Record<string, unknown>): WorldRelation {
  const validFrom = iso(row.valid_from);
  const validTo = iso(row.valid_to);
  return {
    id: String(row.id),
    relationType: String(row.relation_type),
    fromObjectId: String(row.from_object_id),
    toObjectId: String(row.to_object_id),
    persisted: Boolean(row.persisted),
    properties: json<Record<string, unknown>>(row.properties, {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {})
  };
}

export function mapObservation(row: Record<string, unknown>): ObservationEnvelope {
  let geometry = row.geometry_json ? json<Geometry>(row.geometry_json, undefined as never) : undefined;
  if (geometry?.type === "Point" && row.altitude !== null && row.altitude !== undefined) {
    geometry = { type: "Point", coordinates: [geometry.coordinates[0], geometry.coordinates[1], Number(row.altitude)] };
  }
  return {
    observationId: String(row.observation_id),
    observer: { type: String(row.observer_type), id: String(row.observer_id) },
    subject: { type: String(row.subject_type), id: String(row.subject_id) },
    observationType: String(row.observation_type),
    ...(geometry ? { geometry } : {}),
    value: json<Record<string, unknown>>(row.value, {}),
    confidence: Number(row.confidence),
    observedAt: iso(row.observed_at) ?? new Date(0).toISOString(),
    receivedAt: iso(row.received_at) ?? new Date(0).toISOString(),
    source: String(row.source),
    correlationId: String(row.correlation_id),
    ...externalCorrelationFields(row),
    metadata: json<Record<string, unknown>>(row.metadata, {}),
    schemaVersion: row.schema_version === "1.2" ? "1.2" : "1.0"
  };
}

export function mapTrajectoryPoint(row: Record<string, unknown>): TrajectoryPoint {
  const longitude = Number(row.longitude);
  const latitude = Number(row.latitude);
  return {
    entityId: String(row.entity_id),
    timestamp: iso(row.observed_at) ?? new Date(0).toISOString(),
    geometry: { type: "Point", coordinates: [longitude, latitude] },
    latitude,
    longitude,
    ...(row.altitude === null || row.altitude === undefined ? {} : { altitude: Number(row.altitude) }),
    ...(row.heading === null || row.heading === undefined ? {} : { heading: Number(row.heading) }),
    ...(row.speed === null || row.speed === undefined ? {} : { speed: Number(row.speed) }),
    state: json<Record<string, unknown>>(row.state, {}),
    source: String(row.source),
    confidence: Number(row.confidence),
    observationId: String(row.observation_id)
  };
}

export function mapSituationCell(row: Record<string, unknown>): SituationCell {
  const h3Index = String(row.h3_index);
  return {
    h3Index,
    resolution: Number(row.resolution),
    metrics: {
      agentCount: Number(row.agent_count),
      vehicleCount: Number(row.vehicle_count),
      sensorCount: Number(row.sensor_count),
      incidentCount: Number(row.incident_count),
      observationCount: Number(row.observation_count),
      riskScore: Number(row.derived_risk_score ?? row.risk_score ?? 0),
      coverageScore: Number(row.derived_coverage_score ?? row.coverage_score ?? 0),
      activityScore: Number(row.derived_activity_score ?? row.activity_score ?? 0),
      freshnessScore: Number(row.derived_freshness_score ?? row.freshness_score ?? 0)
    },
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    worldVersion: Number(row.world_version ?? 0),
    boundary: h3Boundary(h3Index)
  };
}

export function mapWorldEvent(row: Record<string, unknown>): WorldEvent {
  const geometry = row.geometry_json ? json<Geometry>(row.geometry_json, undefined as never) : undefined;
  return {
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    subject: { type: String(row.subject_type), id: String(row.subject_id) },
    timestamp: iso(row.event_time) ?? new Date(0).toISOString(),
    ...(geometry ? { geometry } : {}),
    worldVersion: Number(row.world_version),
    correlationId: String(row.correlation_id),
    causationId: String(row.causation_id),
    ...externalCorrelationFields(row),
    payload: json<Record<string, unknown>>(row.payload, {}),
    schemaVersion: "1.0",
    ...(row.data_scope_key === null || row.data_scope_key === undefined ? {} : { dataScopeKey: String(row.data_scope_key) })
  };
}

function externalCorrelationFields(row: Record<string, unknown>) {
  return {
    ...(row.execution_intent_id === null || row.execution_intent_id === undefined ? {} : { executionIntentId: String(row.execution_intent_id) }),
    ...(row.operation_correlation_id === null || row.operation_correlation_id === undefined ? {} : { operationCorrelationId: String(row.operation_correlation_id) }),
    ...(row.external_planning_task_id === null || row.external_planning_task_id === undefined ? {} : { externalPlanningTaskId: String(row.external_planning_task_id) }),
    ...(row.external_planning_step_id === null || row.external_planning_step_id === undefined ? {} : { externalPlanningStepId: String(row.external_planning_step_id) }),
    ...(row.provider_action_id === null || row.provider_action_id === undefined ? {} : { providerActionId: String(row.provider_action_id) }),
    ...(row.device_command_id === null || row.device_command_id === undefined ? {} : { deviceCommandId: String(row.device_command_id) })
  };
}
