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

  private lastFeedScope='';
  async appendFeed(limit=500):Promise<number> {
    const scopes=await this.pool.query('SELECT scope_key AS data_scope_key FROM public.data_scope s WHERE EXISTS(SELECT 1 FROM public.world_event_feed_pending p WHERE p.data_scope_key=s.scope_key) ORDER BY (scope_key>$1) DESC,scope_key LIMIT 32',[this.lastFeedScope]);
    let total=0;
    for(const row of scopes.rows) total+=Number((await this.pool.query('SELECT public.append_world_event_feed($1,$2) AS count',[row.data_scope_key,limit])).rows[0].count);
    if(scopes.rows.length) this.lastFeedScope=String(scopes.rows.at(-1).data_scope_key);
    return total;
  }

  async feedCursor(scope:string,eventId:string):Promise<{position:string;event:WorldEvent}|undefined> {
    const result=await this.pool.query(`SELECT f.position::text, e.*,
      CASE WHEN e.geometry IS NULL THEN NULL ELSE public.ST_AsGeoJSON(e.geometry)::jsonb END AS geometry_json
      FROM public.world_event_feed f JOIN public.world_event e USING(event_id)
      WHERE f.data_scope_key=$1 AND e.data_scope_key=$1 AND f.event_id=$2::uuid`,[scope,eventId]);
    const row=result.rows[0];
    return row?{position:String(row.position),event:mapWorldEvent(row)}:undefined;
  }

  async feedPage(scope:string,after:string,limit=500):Promise<Array<{position:string;event:WorldEvent}>> {
    if(!/^\d+$/.test(after)||!Number.isInteger(limit)||limit<1||limit>1000) throw Error('EVENT_FEED_PAGE_INVALID');
    const result=await this.pool.query(`WITH page AS MATERIALIZED (
      SELECT f.position,f.event_id,octet_length(to_jsonb(e)::text) AS bytes
      FROM public.world_event_feed f JOIN public.world_event e USING(event_id)
      WHERE f.data_scope_key=$1 AND e.data_scope_key=$1 AND f.position>$2::bigint ORDER BY f.position LIMIT $3
    ), budget AS (
      SELECT *,sum(bytes) OVER(ORDER BY position) AS used_bytes,row_number() OVER(ORDER BY position) AS ordinal FROM page
    ) SELECT f.position::text,e.*,
      CASE WHEN e.geometry IS NULL THEN NULL ELSE public.ST_AsGeoJSON(e.geometry)::jsonb END AS geometry_json
      FROM budget f JOIN public.world_event e USING(event_id)
      WHERE used_bytes<=4194304 OR ordinal=1 ORDER BY f.position`,[scope,after,limit]);
    return result.rows.map(row=>({position:String(row.position),event:mapWorldEvent(row)}));
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
