import type pg from "pg";
import { loadConfig } from "../../world-model-core/src/config.js";
import {
  assertOperationalTaskEvent,
  parseOperationalEventIngest,
  type OperationalEventIngest,
  type OperationalTaskEvent
} from "../../operational-model/src/events.js";

export interface OperationalEventInsertResult {
  status: "accepted" | "late" | "duplicate";
  arrivalClassification: "CURRENT" | "LATE";
  event: OperationalTaskEvent;
}

export class OperationalEventRepository {
  private readonly config = loadConfig();

  constructor(private readonly pool: pg.Pool) {}

  async insert(candidate: unknown, receivedTime = new Date().toISOString()): Promise<OperationalEventInsertResult> {
    const input = parseOperationalEventIngest(candidate);
    const result = await this.pool.query<{
      ingest_status: "ACCEPTED" | "DUPLICATE";
      stored_world_version: string;
      stored_arrival_classification: "CURRENT" | "LATE";
    }>(
      `SELECT * FROM ingest_operational_task_event(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,
         $14::jsonb,$15,$16::jsonb,$17::jsonb,$18::bigint,$19::bigint
       )`,
      [
        input.dataScopeKey,input.sourceAuthority,input.sourceEventKey,input.sourceRevisionNo,
        input.eventId,input.operationalTaskId,input.eventType,input.eventTime,receivedTime,
        input.subjectReferenceKey ? JSON.stringify(input.subjectReferenceKey) : null,
        JSON.stringify(input.actorReferenceKeys),JSON.stringify(input.targetReferenceKeys),
        input.geometryRef ?? null,JSON.stringify(input.payload),input.confidence ?? null,
        JSON.stringify(input.provenance),JSON.stringify(input.correlationClaims ?? []),
        this.config.maxFutureSkewMs,this.config.maxLateArrivalMs
      ]
    );
    const outcome = result.rows[0];
    if (!outcome) throw new Error("operational event ingest returned no outcome");
    const event = await this.get(input.dataScopeKey,input.eventId);
    if (!event) throw new Error("operational event was not persisted");
    return {
      status: outcome.ingest_status === "DUPLICATE"
        ? "duplicate"
        : outcome.stored_arrival_classification === "LATE" ? "late" : "accepted",
      arrivalClassification: outcome.stored_arrival_classification,
      event
    };
  }

  async get(dataScopeKey: string,eventId: string): Promise<OperationalTaskEvent | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM operational_task_event WHERE data_scope_key=$1 AND event_id=$2`,
      [dataScopeKey,eventId]
    );
    const row = result.rows[0] as Record<string,unknown> | undefined;
    return row ? mapOperationalTaskEvent(row) : undefined;
  }

  async timeline(dataScopeKey: string,operationalTaskId: string,limit = 1_000): Promise<OperationalTaskEvent[]> {
    const result = await this.pool.query(
      `SELECT * FROM operational_task_event
       WHERE data_scope_key=$1 AND operational_task_id=$2
       ORDER BY event_time,received_time,event_id LIMIT $3`,
      [dataScopeKey,operationalTaskId,Math.min(Math.max(limit,1),1_000)]
    );
    return result.rows.map((row) => mapOperationalTaskEvent(row as Record<string,unknown>));
  }
}

function mapOperationalTaskEvent(row: Record<string,unknown>): OperationalTaskEvent {
  const event: OperationalTaskEvent = {
    eventId: String(row.event_id),
    operationalTaskId: String(row.operational_task_id),
    eventType: String(row.event_type) as OperationalTaskEvent["eventType"],
    eventTime: iso(row.event_time),
    receivedTime: iso(row.received_time),
    ...(row.subject_reference_key ? { subjectReferenceKey: json(row.subject_reference_key) } : {}),
    actorReferenceKeys: json(row.actor_reference_keys),
    targetReferenceKeys: json(row.target_reference_keys),
    ...(row.geometry_ref ? { geometryRef: String(row.geometry_ref) } : {}),
    payload: json(row.payload),
    ...(row.confidence === null || row.confidence === undefined ? {} : { confidence: Number(row.confidence) }),
    provenance: json(row.provenance),
    ...(Array.isArray(json<unknown[]>(row.correlation_claims)) && json<unknown[]>(row.correlation_claims).length
      ? { correlationClaims: json(row.correlation_claims) }
      : {}),
    worldVersion: Number(row.world_version)
  };
  assertOperationalTaskEvent(event);
  return event;
}

function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
