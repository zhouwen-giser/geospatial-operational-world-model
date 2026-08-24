import { randomUUID } from "node:crypto";
import type { ExternalCorrelationMetadata, Geometry, SubjectRef, WorldEvent, WorldEventType } from "../../world-model-core/src/types.js";

export interface EventInput extends ExternalCorrelationMetadata {
  eventType: WorldEventType;
  subject: SubjectRef;
  worldVersion: number;
  correlationId: string;
  causationId: string;
  payload?: Record<string, unknown>;
  geometry?: Geometry;
  timestamp?: string;
  dataScopeKey?: string;
}

export function createWorldEvent(input: EventInput): WorldEvent {
  return {
    eventId: randomUUID(),
    eventType: input.eventType,
    subject: input.subject,
    timestamp: input.timestamp ?? new Date().toISOString(),
    ...(input.geometry ? { geometry: input.geometry } : {}),
    worldVersion: input.worldVersion,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: input.payload ?? {},
    schemaVersion: "1.0",
    ...(input.dataScopeKey === undefined ? {} : { dataScopeKey: input.dataScopeKey }),
    ...externalCorrelationFields(input)
  };
}

function externalCorrelationFields(input: ExternalCorrelationMetadata): ExternalCorrelationMetadata {
  return {
    ...(input.executionIntentId === undefined ? {} : { executionIntentId: input.executionIntentId }),
    ...(input.operationCorrelationId === undefined ? {} : { operationCorrelationId: input.operationCorrelationId }),
    ...(input.externalPlanningTaskId === undefined ? {} : { externalPlanningTaskId: input.externalPlanningTaskId }),
    ...(input.externalPlanningStepId === undefined ? {} : { externalPlanningStepId: input.externalPlanningStepId }),
    ...(input.providerActionId === undefined ? {} : { providerActionId: input.providerActionId }),
    ...(input.deviceCommandId === undefined ? {} : { deviceCommandId: input.deviceCommandId })
  };
}
