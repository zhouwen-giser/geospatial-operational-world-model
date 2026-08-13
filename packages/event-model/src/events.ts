import { randomUUID } from "node:crypto";
import type { Geometry, SubjectRef, WorldEvent, WorldEventType } from "../../world-model-core/src/types.js";

export interface EventInput {
  eventType: WorldEventType;
  subject: SubjectRef;
  worldVersion: number;
  correlationId: string;
  causationId: string;
  payload?: Record<string, unknown>;
  geometry?: Geometry;
  timestamp?: string;
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
    schemaVersion: "1.0"
  };
}
