import type pg from "pg";
import type { WorldEvent } from "../../world-model-core/src/types.js";
import { mapWorldEvent } from "./row-mappers.js";

const EVENT_SELECT = `
  SELECT *, CASE WHEN geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(geometry)::jsonb END AS geometry_json
  FROM world_event`;

export class EventRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(options: {
    eventType?: string;
    objectType?: string;
    subjectId?: string;
    sinceWorldVersion?: number;
    areaId?: string;
    limit?: number;
  }): Promise<WorldEvent[]> {
    const conditions = ["true"];
    const params: unknown[] = [];
    const add = (condition: string, value: unknown) => {
      params.push(value);
      conditions.push(condition.replace("?", `$${params.length}`));
    };
    if (options.eventType) add("e.event_type = ?", options.eventType);
    if (options.objectType) add("e.subject_type = ?", options.objectType);
    if (options.subjectId) add("e.subject_id = ?", options.subjectId);
    if (options.sinceWorldVersion !== undefined) add("e.world_version > ?", options.sinceWorldVersion);
    if (options.areaId) add("e.payload->>'areaId' = ?", options.areaId);
    params.push(options.limit ?? 1_000);
    const sql = EVENT_SELECT.replace("FROM world_event", "FROM world_event e");
    const result = await this.pool.query(
      `${sql} WHERE ${conditions.join(" AND ")} ORDER BY e.world_version, e.created_at, e.event_id LIMIT $${params.length}`,
      params
    );
    return result.rows.map((row) => mapWorldEvent(row as Record<string, unknown>));
  }

  async unpublished(limit = 200): Promise<WorldEvent[]> {
    const result = await this.pool.query(
      `${EVENT_SELECT} WHERE published_at IS NULL ORDER BY created_at, event_id LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => mapWorldEvent(row as Record<string, unknown>));
  }

  async markPublished(eventId: string): Promise<void> {
    await this.pool.query("UPDATE world_event SET published_at = clock_timestamp() WHERE event_id = $1::uuid", [eventId]);
  }
}
