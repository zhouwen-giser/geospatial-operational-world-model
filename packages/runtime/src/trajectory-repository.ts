import type pg from "pg";
import type { TrajectoryPoint } from "../../world-model-core/src/types.js";
import { mapTrajectoryPoint } from "./row-mappers.js";

export class TrajectoryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async currentPosition(entityId: string): Promise<TrajectoryPoint | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM trajectory_point WHERE entity_id = $1
       ORDER BY observed_at DESC, observation_id DESC LIMIT 1`,
      [entityId]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapTrajectoryPoint(row) : undefined;
  }

  async track(entityId: string, options: { from?: string; to?: string; limit: number }): Promise<TrajectoryPoint[]> {
    const conditions = ["entity_id = $1"];
    const params: unknown[] = [entityId];
    if (options.from) {
      params.push(options.from);
      conditions.push(`observed_at >= $${params.length}`);
    }
    if (options.to) {
      params.push(options.to);
      conditions.push(`observed_at <= $${params.length}`);
    }
    params.push(options.limit);
    const result = await this.pool.query(
      `SELECT * FROM trajectory_point WHERE ${conditions.join(" AND ")}
       ORDER BY observed_at, observation_id LIMIT $${params.length}`,
      params
    );
    return result.rows.map((row) => mapTrajectoryPoint(row as Record<string, unknown>));
  }

  async recentTrack(entityId: string, durationMs: number, limit = 10_000): Promise<TrajectoryPoint[]> {
    const result = await this.pool.query(
      `SELECT * FROM trajectory_point
       WHERE entity_id = $1 AND observed_at >= clock_timestamp() - ($2::text || ' milliseconds')::interval
       ORDER BY observed_at, observation_id LIMIT $3`,
      [entityId, durationMs, limit]
    );
    return result.rows.map((row) => mapTrajectoryPoint(row as Record<string, unknown>));
  }
}
