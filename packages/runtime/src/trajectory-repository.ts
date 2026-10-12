import type pg from "pg";
import type { MobilityTrajectory, TrajectoryPoint } from "../../world-model-core/src/types.js";
import { mapTrajectoryPoint } from "./row-mappers.js";
import type { TrackQuerySchema } from "../../world-model-core/src/schema.js";
import type { z } from "zod";

export class TrajectoryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async currentPosition(entityId: string,dataScopeKey='default'): Promise<TrajectoryPoint | undefined> {
    const result = await this.pool.query(
      `SELECT p.* FROM trajectory_point p JOIN world_observation o USING(observation_id) WHERE p.entity_id = $1 AND o.data_scope_key=$2
       ORDER BY p.observed_at DESC, p.observation_id DESC LIMIT 1`,
      [entityId,dataScopeKey]
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

  async continuousTrack(entityId: string, options: z.infer<typeof TrackQuerySchema>, dataScopeKey: string) {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SELECT set_config('gowm.data_scope_key',$1,true)",[dataScopeKey]);
      const result=(await c.query('SELECT gowm_history_v1.compatibility_trajectory($1,$2,$3::jsonb) AS result',[dataScopeKey,entityId,JSON.stringify(options)])).rows[0].result;
      await c.query('COMMIT');
      const rows=result.points as Record<string,unknown>[];
      const points=rows.slice(0,options.limit).map(row=>({...mapTrajectoryPoint(row),
        sequenceKey:`${result.identity?.trackletVersionId}:${row.segment_no}`,
        measurementId:String(row.measurement_id),timeSolutionId:String(row.time_solution_id)}));
      const groups=new Map<string,typeof points>();
      for (const point of points) { const group=groups.get(point.sequenceKey)??[]; group.push(point); groups.set(point.sequenceKey,group); }
      return { ...result,points,segments:[...groups.values()] };
    } catch(error) {
      await c.query('ROLLBACK');
      const e=error as Error & {statusCode?:number};
      if (e.message==='TRAJECTORY_SELECTION_AMBIGUOUS') e.statusCode=409;
      if (e.message==='TRAJECTORY_QUERY_INVALID') e.statusCode=422;
      throw error;
    } finally {c.release();}
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

  async mobilityTrajectory(entityId: string, source?: string,dataScopeKey='default'): Promise<MobilityTrajectory | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM mobility_trajectory_current
       WHERE (world_object_id=$1 OR source_local_target_id=$1)
         AND ($2::text IS NULL OR source_key=$2) AND data_scope_key=$3
       ORDER BY end_event_time DESC,tracklet_id LIMIT 1`,
      [entityId,source ?? null,dataScopeKey]
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
