import type pg from "pg";
import type { MobilityTrajectory, TrajectoryPoint } from "../../world-model-core/src/types.js";
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

  async mobilityTrajectory(entityId: string, source?: string): Promise<MobilityTrajectory | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM mobility_trajectory_current
       WHERE (world_object_id=$1 OR source_local_target_id=$1)
         AND ($2::text IS NULL OR source_key=$2)
       ORDER BY end_event_time DESC,tracklet_id LIMIT 1`,
      [entityId,source ?? null]
    );
    const row = result.rows[0] as Record<string,unknown> | undefined;
    if (!row) return undefined;
    const gaps = await this.pool.query(
      `SELECT g.gap_no,lower(g.gap_time) AS start_time,upper(g.gap_time) AS end_time,
              g.reason_codes,g.observability_state
       FROM mobility_tracklet_gap g WHERE g.tracklet_version_id=$1 ORDER BY g.gap_no`,
      [row.tracklet_version_id]
    );
    return {
      trackletId: String(row.tracklet_id),
      trackletVersionId: String(row.tracklet_version_id),
      ...(row.world_object_id ? { entityId: String(row.world_object_id) } : {}),
      source: String(row.source_key),
      sourceLocalTargetId: String(row.source_local_target_id),
      trackerSessionKey: String(row.tracker_session_key),
      analysisSpaceKey: String(row.analysis_space_key),
      version: Number(row.version_no),
      state: String(row.version_state) as MobilityTrajectory["state"],
      sequenceCount: Number(row.sequence_count),
      sampleCount: Number(row.sample_count),
      startTime: new Date(String(row.start_event_time)).toISOString(),
      endTime: new Date(String(row.end_event_time)).toISOString(),
      trajectory: typeof row.trajectory_json === "string"
        ? JSON.parse(row.trajectory_json) as Record<string,unknown>
        : row.trajectory_json as Record<string,unknown>,
      gaps: gaps.rows.map((gap) => ({
        gapNo: Number(gap.gap_no),
        start: new Date(String(gap.start_time)).toISOString(),
        end: new Date(String(gap.end_time)).toISOString(),
        bounds: "()" as const,
        reasonCodes: gap.reason_codes as string[],
        observabilityState: String(gap.observability_state)
      }))
    };
  }
}
