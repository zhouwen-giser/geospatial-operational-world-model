import type pg from "pg";
import {
  assertOperationalEventTimeline,
  assertOperationalQueryResult,
  assertOperationalTaskEvent,
  assertOperationalTaskSnapshot,
  type OperationalEventTimeline,
  type OperationalQueryResult,
  type OperationalReferenceKey,
  type OperationalTaskEvent,
  type OperationalTaskSnapshot
} from "../../operational-model/src/events.js";

export interface OperationalReadSnapshot {
  worldVersion: number;
  scopeDigest: string;
}

export class OperationalReadRepository {
  constructor(private readonly pool: pg.Pool) {}

  async find(dataScopeKey: string,options: {
    referenceKey?: OperationalReferenceKey;
    actorReferenceKeys?: OperationalReferenceKey[];
    from?: string;
    to?: string;
    limit?: number;
  } = {}): Promise<{ result: OperationalQueryResult;snapshot: OperationalReadSnapshot }> {
    return this.read(dataScopeKey,async (client,snapshot) => {
      const conditions = ["true"];
      const values: unknown[] = [];
      const add = (condition: string,value: unknown) => {
        values.push(value);
        conditions.push(condition.replace("?",`$${values.length}`));
      };
      if (options.referenceKey) add("reference_key=?",options.referenceKey.id);
      if (options.from) add("last_observed_at>=?::timestamptz",options.from);
      if (options.to) add("first_observed_at<=?::timestamptz",options.to);
      if (options.actorReferenceKeys?.length) {
        add(`EXISTS (
          SELECT 1 FROM jsonb_array_elements(?::jsonb) requested
          JOIN jsonb_array_elements(actor_reference_keys) observed ON requested=observed
        )`,JSON.stringify(options.actorReferenceKeys));
      }
      const limit = Math.min(Math.max(options.limit ?? 100,1),1_000);
      values.push(limit+1);
      const rows = await client.query(
        `SELECT * FROM gowm_operational_reality_v1.task_snapshot
         WHERE ${conditions.join(" AND ")}
         ORDER BY last_observed_at DESC NULLS LAST,operational_task_id,reference_key
         LIMIT $${values.length}`,
        values
      );
      const truncated = rows.rows.length>limit;
      const result: OperationalQueryResult = {
        schemaVersion: "1.0",
        tasks: rows.rows.slice(0,limit).map((row) => mapSnapshot(row as Record<string,unknown>)),
        truncated
      };
      assertOperationalQueryResult(result);
      return { result,snapshot };
    });
  }

  async timeline(dataScopeKey: string,referenceKey: OperationalReferenceKey,options: {
    from?: string;to?: string;limit?: number;
  } = {}): Promise<{ result: OperationalEventTimeline;snapshot: OperationalReadSnapshot }> {
    return this.read(dataScopeKey,async (client,snapshot) => {
      const values: unknown[] = [referenceKey.id];
      const conditions = ["reference_key=$1"];
      if (options.from) { values.push(options.from);conditions.push(`event_time>=$${values.length}::timestamptz`); }
      if (options.to) { values.push(options.to);conditions.push(`event_time<=$${values.length}::timestamptz`); }
      const limit = Math.min(Math.max(options.limit ?? 100,1),1_000);
      values.push(limit+1);
      const rows = await client.query(
        `SELECT * FROM gowm_operational_reality_v1.task_event
         WHERE ${conditions.join(" AND ")}
         ORDER BY event_time,received_time,event_id LIMIT $${values.length}`,
        values
      );
      const truncated = rows.rows.length>limit;
      const result: OperationalEventTimeline = {
        schemaVersion: "1.0",operationalTaskReferenceKey: referenceKey,
        events: rows.rows.slice(0,limit).map((row) => mapEvent(row as Record<string,unknown>)),truncated
      };
      assertOperationalEventTimeline(result);
      return { result,snapshot };
    });
  }

  private async read<T>(dataScopeKey: string,action: (
    client: pg.PoolClient,snapshot: OperationalReadSnapshot
  ) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SELECT gowm_operational_reality_v1.set_data_scope($1)",[dataScopeKey]);
      const context = await client.query<{ world_version: string;scope_digest: string }>(
        "SELECT * FROM gowm_operational_reality_v1.snapshot_context()"
      );
      const row = context.rows[0];
      if (!row) throw new Error("operational read snapshot context is unavailable");
      const result = await action(client,{ worldVersion: Number(row.world_version),scopeDigest: row.scope_digest });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapSnapshot(row: Record<string,unknown>): OperationalTaskSnapshot {
  const snapshot: OperationalTaskSnapshot = {
    referenceKey: json(row.reference_key_value),operationalTaskId: String(row.operational_task_id),
    taskType: String(row.task_type),controlState: String(row.control_state) as OperationalTaskSnapshot["controlState"],
    activityState: String(row.activity_state) as OperationalTaskSnapshot["activityState"],
    outcomeVerification: String(row.outcome_verification) as OperationalTaskSnapshot["outcomeVerification"],
    observability: String(row.observability) as OperationalTaskSnapshot["observability"],
    actorReferenceKeys: json(row.actor_reference_keys),targetReferenceKeys: json(row.target_reference_keys),
    ...(row.first_observed_at ? { firstObservedAt: iso(row.first_observed_at) } : {}),
    ...(row.last_observed_at ? { lastObservedAt: iso(row.last_observed_at) } : {}),
    ...(row.last_received_at ? { lastReceivedAt: iso(row.last_received_at) } : {}),
    evidenceIds: json(row.evidence_ids),worldVersion: Number(row.world_version),
    projectionPolicyVersion: String(row.projection_policy_version)
  };
  assertOperationalTaskSnapshot(snapshot);
  return snapshot;
}

function mapEvent(row: Record<string,unknown>): OperationalTaskEvent {
  const event: OperationalTaskEvent = {
    eventId: String(row.event_id),operationalTaskId: String(row.operational_task_id),
    eventType: String(row.event_type) as OperationalTaskEvent["eventType"],
    eventTime: iso(row.event_time),receivedTime: iso(row.received_time),
    ...(row.subject_reference_key ? { subjectReferenceKey: json(row.subject_reference_key) } : {}),
    actorReferenceKeys: json(row.actor_reference_keys),targetReferenceKeys: json(row.target_reference_keys),
    ...(row.geometry_ref ? { geometryRef: String(row.geometry_ref) } : {}),payload: json(row.payload),
    ...(row.confidence===null || row.confidence===undefined ? {} : { confidence: Number(row.confidence) }),
    provenance: json(row.provenance),
    ...(Array.isArray(json<unknown[]>(row.correlation_claims)) && json<unknown[]>(row.correlation_claims).length
      ? { correlationClaims: json(row.correlation_claims) } : {}),
    worldVersion: Number(row.world_version)
  };
  assertOperationalTaskEvent(event);
  return event;
}

function json<T>(value: unknown): T {
  return (typeof value==="string" ? JSON.parse(value) : value) as T;
}
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
