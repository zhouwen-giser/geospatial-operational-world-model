import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Geometry, WorldEvent, WorldObject, WorldRelation } from "../../world-model-core/src/types.js";
import { loadConfig } from "../../world-model-core/src/config.js";
import { createWorldEvent } from "../../event-model/src/events.js";
import { mapRelation, mapWorldObject } from "./row-mappers.js";
import { withTransaction } from "./db.js";

const CURRENT_SELECT = `
  SELECT o.id,o.data_scope_key,o.object_type, o.subtype, o.properties,
         s.state, s.confidence, s.observed_at, s.received_at, s.source,
         s.source_observation_id,s.time_solution_id,s.position_measurement_id,
         s.projection_policy_version,s.uncertainty_summary,s.evidence_kind,s.version,s.updated_at,
         CASE WHEN g.geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(g.geometry)::jsonb END AS geometry_json,
         g.h3_r7, g.h3_r8, g.h3_r9, g.h3_r10
  FROM world_object o
  JOIN world_object_state s ON s.object_id = o.id
  LEFT JOIN world_object_geometry g ON g.object_id = o.id
`;

export interface CreateWorldObjectInput {
  id: string;
  type: string;
  subtype?: string;
  state: Record<string, unknown>;
  properties: Record<string, unknown>;
  geometry?: Geometry;
  confidence: number;
}

export interface PatchWorldObjectInput {
  state?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  geometry?: Geometry;
  confidence?: number;
  expectedVersion?: number;
}

export async function insertEvent(client: pg.PoolClient, event: WorldEvent): Promise<void> {
  await client.query(
    `INSERT INTO world_event (
       event_id, event_type, subject_type, subject_id, event_time, geometry,
       world_version, correlation_id, causation_id, payload, schema_version,data_scope_key,
       execution_intent_id,operation_correlation_id,external_planning_task_id,
       external_planning_step_id,provider_action_id,device_command_id
     ) VALUES (
       $1::uuid, $2, $3, $4, $5,
       CASE WHEN $6::jsonb IS NULL THEN NULL ELSE ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($6::jsonb)), 4326) END,
       $7, $8, $9, $10::jsonb, $11,
       COALESCE($12,(SELECT data_scope_key FROM world_object WHERE id=$4),'default'),
       $13,$14,$15,$16,$17,$18
     )`,
    [
      event.eventId, event.eventType, event.subject.type, event.subject.id, event.timestamp,
      event.geometry ? JSON.stringify(event.geometry) : null, event.worldVersion,
      event.correlationId, event.causationId, JSON.stringify(event.payload), event.schemaVersion,
      event.dataScopeKey ?? null,event.executionIntentId ?? null,event.operationCorrelationId ?? null,
      event.externalPlanningTaskId ?? null,event.externalPlanningStepId ?? null,
      event.providerActionId ?? null,event.deviceCommandId ?? null
    ]
  );
}

export class WorldRepository {
  private readonly staleAfterMs = loadConfig().staleAfterMs;

  constructor(private readonly pool: pg.Pool) {}

  async health(): Promise<{
    database: "ok";
    postgisVersion: string;
    mobilityDbVersion: string;
    h3PgVersion: string;
    contractVersion: string;
    analysisSrid: number;
    worldVersion: number;
  }> {
    const result = await this.pool.query<{
      version: string; mobility_version: string; h3_version: string; contract_version: string;
      analysis_srid: number; world_version: string;
    }>(
      `SELECT PostGIS_Lib_Version() AS version,
              (SELECT extversion FROM pg_extension WHERE extname='mobilitydb') AS mobility_version,
              (SELECT extversion FROM pg_extension WHERE extname = 'h3') AS h3_version,
              (SELECT contract_version FROM gowm_deployment_config WHERE singleton) AS contract_version,
              (SELECT analysis_srid FROM gowm_deployment_config WHERE singleton) AS analysis_srid,
              last_value::text AS world_version
       FROM world_version_seq`
    );
    return {
      database: "ok",
      postgisVersion: result.rows[0]?.version ?? "unknown",
      mobilityDbVersion: result.rows[0]?.mobility_version ?? "missing",
      h3PgVersion: result.rows[0]?.h3_version ?? "missing",
      contractVersion: result.rows[0]?.contract_version ?? "unknown",
      analysisSrid: Number(result.rows[0]?.analysis_srid ?? 0),
      worldVersion: Number(result.rows[0]?.world_version ?? 0)
    };
  }

  async worldVersion(): Promise<number> {
    const result = await this.pool.query<{ value: string }>("SELECT last_value::text AS value FROM world_version_seq");
    return Number(result.rows[0]?.value ?? 0);
  }

  async createObject(input: CreateWorldObjectInput): Promise<WorldObject> {
    const commandId = `manual:${randomUUID()}`;
    const initialState = withGeometryPosition(input.state, input.geometry);
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO world_object (id, object_type, subtype, properties)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [input.id, input.type, input.subtype ?? null, JSON.stringify(input.properties)]
      );
      const stateResult = await client.query<{ version: string }>(
        `INSERT INTO world_object_state (
           object_id, state, confidence, observed_at, received_at, source,
           source_observation_id, version
         ) VALUES (
           $1, $2::jsonb, $3, clock_timestamp(), clock_timestamp(), 'manual',
           $4, nextval('world_version_seq')
         )
         RETURNING version::text`,
        [input.id, JSON.stringify(initialState), input.confidence, commandId]
      );
      const version = Number(stateResult.rows[0]?.version ?? 0);
      if (input.geometry) await this.upsertGeometry(client, input.id, input.geometry, undefined);
      await insertEvent(client, createWorldEvent({
        eventType: "ObjectCreated",
        subject: { type: input.type, id: input.id },
        worldVersion: version,
        correlationId: input.id,
        causationId: commandId,
        ...(input.geometry ? { geometry: input.geometry } : {}),
        payload: { subtype: input.subtype, initialState }
      }));
    });
    const object = await this.getObject(input.id);
    if (!object) throw new Error("object was not persisted");
    return object;
  }

  async patchObject(id: string, input: PatchWorldObjectInput): Promise<WorldObject | undefined> {
    const commandId = `manual:${randomUUID()}`;
    const touchesDynamicState = Boolean(input.state || input.geometry || input.confidence !== undefined);
    const statePatch = withGeometryPosition(input.state ?? {}, input.geometry);
    const found = await withTransaction(this.pool, async (client) => {
      const current = await client.query<{ object_type: string; version: string }>(
        `SELECT o.object_type, s.version::text
         FROM world_object o JOIN world_object_state s ON s.object_id = o.id
         WHERE o.id = $1 AND o.deleted_at IS NULL FOR UPDATE OF o, s`,
        [id]
      );
      const row = current.rows[0];
      if (!row) return false;
      const currentVersion = Number(row.version);
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw Object.assign(new Error(`version conflict: expected ${input.expectedVersion}, current ${currentVersion}`), { statusCode: 409 });
      }
      const versionResult = await client.query<{ version: string }>(
        `UPDATE world_object_state
         SET state = state || COALESCE($2::jsonb, '{}'::jsonb),
             confidence = COALESCE($3, confidence),
             observed_at = CASE WHEN $4 THEN clock_timestamp() ELSE observed_at END,
             received_at = CASE WHEN $4 THEN clock_timestamp() ELSE received_at END,
             source = CASE WHEN $4 THEN 'manual' ELSE source END,
             source_observation_id = CASE WHEN $4 THEN $5 ELSE source_observation_id END,
             version = nextval('world_version_seq'), updated_at = clock_timestamp()
         WHERE object_id = $1 RETURNING version::text`,
        [id, Object.keys(statePatch).length ? JSON.stringify(statePatch) : null, input.confidence ?? null, touchesDynamicState, commandId]
      );
      await client.query(
        `UPDATE world_object
         SET properties = properties || COALESCE($2::jsonb, '{}'::jsonb), updated_at = clock_timestamp()
         WHERE id = $1`,
        [id, input.properties ? JSON.stringify(input.properties) : null]
      );
      if (input.geometry) await this.upsertGeometry(client, id, input.geometry, undefined);
      const version = Number(versionResult.rows[0]?.version ?? currentVersion);
      await insertEvent(client, createWorldEvent({
        eventType: input.geometry
          ? "ObjectMoved"
          : input.state || input.confidence !== undefined
            ? "ObjectStateChanged"
            : "ObjectUpdated",
        subject: { type: row.object_type, id },
        worldVersion: version,
        correlationId: id,
        causationId: commandId,
        ...(input.geometry ? { geometry: input.geometry } : {}),
        payload: {
          changedState: [
            ...Object.keys(input.state ?? {}),
            ...(input.geometry?.type === "Point" ? ["position"] : [])
          ],
          changedProperties: Object.keys(input.properties ?? {})
        }
      }));
      return true;
    });
    return found ? await this.getObject(id) : undefined;
  }

  private async upsertGeometry(client: pg.PoolClient, objectId: string, geometry: Geometry, observedAt: string | undefined): Promise<void> {
    await client.query(
      `WITH prepared AS (
         SELECT ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($2::jsonb)), 4326) AS geometry
       )
       INSERT INTO world_object_geometry (object_id, geometry, h3_r7, h3_r8, h3_r9, h3_r10, observed_at)
       SELECT $1, geometry,
              h3_latlng_to_cell(ST_Centroid(geometry), 7),
              h3_latlng_to_cell(ST_Centroid(geometry), 8),
              h3_latlng_to_cell(ST_Centroid(geometry), 9),
              h3_latlng_to_cell(ST_Centroid(geometry), 10),
              $3
       FROM prepared
       ON CONFLICT (object_id) DO UPDATE SET
         geometry = EXCLUDED.geometry, h3_r7 = EXCLUDED.h3_r7, h3_r8 = EXCLUDED.h3_r8,
         h3_r9 = EXCLUDED.h3_r9, h3_r10 = EXCLUDED.h3_r10,
         observed_at = EXCLUDED.observed_at, updated_at = clock_timestamp()`,
      [objectId, JSON.stringify(geometry), observedAt ?? null]
    );
  }

  async getObject(id: string, includeRelations = true): Promise<WorldObject | undefined> {
    const result = await this.pool.query(`${CURRENT_SELECT} WHERE o.id = $1 AND o.deleted_at IS NULL`, [id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const relations = includeRelations ? await this.getRelations(id) : undefined;
    return mapWorldObject(row, this.staleAfterMs, relations);
  }

  async findObjects(options: {
    objectTypes?: string[];
    filter?: Record<string, unknown>;
    query?: string;
    limit?: number;
    offset?: number;
  }): Promise<WorldObject[]> {
    const conditions = ["o.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (options.objectTypes?.length) {
      params.push(options.objectTypes);
      conditions.push(`o.object_type = ANY($${params.length}::text[])`);
    }
    if (options.filter && Object.keys(options.filter).length) {
      params.push(JSON.stringify(options.filter));
      conditions.push(`(s.state @> $${params.length}::jsonb OR o.properties @> $${params.length}::jsonb)`);
    }
    if (options.query) {
      params.push(`%${options.query}%`);
      conditions.push(`(o.id ILIKE $${params.length} OR o.object_type ILIKE $${params.length} OR COALESCE(o.subtype, '') ILIKE $${params.length})`);
    }
    params.push(options.limit ?? 100);
    const limitParameter = params.length;
    params.push(options.offset ?? 0);
    const result = await this.pool.query(
      `${CURRENT_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY o.id LIMIT $${limitParameter} OFFSET $${params.length}`,
      params
    );
    return result.rows.map((row) => mapWorldObject(row as Record<string, unknown>, this.staleAfterMs));
  }

  async createRelation(input: Omit<WorldRelation, "id" | "validFrom" | "validTo">): Promise<WorldRelation> {
    const result = await this.pool.query(
      `INSERT INTO world_relation (relation_type, from_object_id, to_object_id, persisted, properties)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
      [input.relationType, input.fromObjectId, input.toObjectId, input.persisted, JSON.stringify(input.properties ?? {})]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("relation was not persisted");
    return mapRelation(row);
  }

  async getRelations(objectId: string): Promise<WorldRelation[]> {
    const result = await this.pool.query(
      `SELECT * FROM world_relation
       WHERE (from_object_id = $1 OR to_object_id = $1) AND valid_to IS NULL
       ORDER BY relation_type, from_object_id, to_object_id`,
      [objectId]
    );
    return result.rows.map((row) => mapRelation(row as Record<string, unknown>));
  }
}

function withGeometryPosition(state: Record<string, unknown>, geometry: Geometry | undefined): Record<string, unknown> {
  if (geometry?.type !== "Point") return state;
  return {
    ...state,
    position: {
      longitude: geometry.coordinates[0],
      latitude: geometry.coordinates[1],
      ...(geometry.coordinates[2] === undefined ? {} : { altitude: geometry.coordinates[2] })
    }
  };
}
