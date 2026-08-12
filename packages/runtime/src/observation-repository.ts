import type pg from "pg";
import type { ObservationEnvelope, WorldEvent } from "../../world-model-core/src/types.js";
import { createWorldEvent } from "../../event-model/src/events.js";
import { mapObservation } from "./row-mappers.js";
import { insertEvent } from "./world-repository.js";
import { withTransaction } from "./db.js";

export interface ObservationInsertResult {
  status: "accepted" | "duplicate" | "late";
  observation: ObservationEnvelope;
  event?: WorldEvent;
}

const OBSERVATION_SELECT = `
  SELECT *, CASE WHEN geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(geometry)::jsonb END AS geometry_json
  FROM world_observation`;

export class ObservationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insert(
    observation: ObservationEnvelope,
    disposition: { status?: "accepted" | "late"; project?: boolean; rejectionReason?: string } = {}
  ): Promise<ObservationInsertResult> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `INSERT INTO world_observation (
           observation_id, observer_type, observer_id, subject_type, subject_id,
           observation_type, geometry, altitude, value, confidence, observed_at, received_at,
           source, correlation_id, metadata, schema_version, status, rejection_reason
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           CASE WHEN $7::jsonb IS NULL THEN NULL ELSE ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($7::jsonb)), 4326) END,
           $8, $9::jsonb, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18
         ) ON CONFLICT (observation_id) DO NOTHING
         RETURNING observation_id`,
        [
          observation.observationId, observation.observer.type, observation.observer.id,
          observation.subject.type, observation.subject.id, observation.observationType,
          observation.geometry ? JSON.stringify(observation.geometry) : null,
          observation.geometry?.type === "Point" ? observation.geometry.coordinates[2] ?? null : null,
          JSON.stringify(observation.value), observation.confidence, observation.observedAt,
          observation.receivedAt, observation.source, observation.correlationId,
          JSON.stringify(observation.metadata), observation.schemaVersion,
          disposition.status ?? "accepted", disposition.rejectionReason ?? null
        ]
      );
      if (!result.rowCount) {
        const existing = await client.query(`${OBSERVATION_SELECT} WHERE observation_id = $1`, [observation.observationId]);
        const row = existing.rows[0] as Record<string, unknown> | undefined;
        return { status: "duplicate", observation: row ? mapObservation(row) : observation };
      }

      if (disposition.project !== false) {
        await client.query("INSERT INTO projection_queue(observation_id) VALUES ($1)", [observation.observationId]);
      }
      const versionResult = await client.query<{ value: string }>("SELECT last_value::text AS value FROM world_version_seq");
      const event = createWorldEvent({
        eventType: "ObservationReceived",
        subject: observation.subject,
        worldVersion: Number(versionResult.rows[0]?.value ?? 0),
        correlationId: observation.correlationId,
        causationId: observation.observationId,
        ...(observation.geometry ? { geometry: observation.geometry } : {}),
        timestamp: observation.receivedAt,
        payload: {
          observationId: observation.observationId,
          observer: observation.observer,
          observationType: observation.observationType,
          confidence: observation.confidence,
          source: observation.source,
          observedAt: observation.observedAt
        }
      });
      await insertEvent(client, event);
      return { status: disposition.status ?? "accepted", observation, event };
    });
  }

  async get(observationId: string): Promise<ObservationEnvelope | undefined> {
    const result = await this.pool.query(`${OBSERVATION_SELECT} WHERE observation_id = $1`, [observationId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapObservation(row) : undefined;
  }

  async query(options: {
    subjectId?: string;
    observerId?: string;
    observationType?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<ObservationEnvelope[]> {
    const conditions = ["true"];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace("?", `$${params.length}`));
    };
    if (options.subjectId) add("subject_id = ?", options.subjectId);
    if (options.observerId) add("observer_id = ?", options.observerId);
    if (options.observationType) add("observation_type = ?", options.observationType);
    if (options.from) add("observed_at >= ?", options.from);
    if (options.to) add("observed_at <= ?", options.to);
    params.push(options.limit ?? 1_000);
    const result = await this.pool.query(
      `${OBSERVATION_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY observed_at DESC, observation_id LIMIT $${params.length}`,
      params
    );
    return result.rows.map((row) => mapObservation(row as Record<string, unknown>));
  }

  async claimBatch(workerName: string, batchSize: number): Promise<string[]> {
    const result = await this.pool.query<{ observation_id: string }>(
      "SELECT observation_id FROM claim_projection_batch($1, $2)",
      [workerName, batchSize]
    );
    return result.rows.map((row) => row.observation_id);
  }

  async markFailure(observationId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.pool.query(
      `UPDATE projection_queue
       SET locked_at = NULL, locked_by = NULL, last_error = $2,
           available_at = clock_timestamp() + LEAST(interval '5 minutes', make_interval(secs => power(2, LEAST(attempts, 8))::integer))
       WHERE observation_id = $1`,
      [observationId, message.slice(0, 4_000)]
    );
  }
}
