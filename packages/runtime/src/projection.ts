import type pg from "pg";
import type {
  CurrentProjection,
  H3Projection,
  ObservationEnvelope,
  PointGeometry,
  ProjectionDecision,
  WorldEvent
} from "../../world-model-core/src/types.js";
import { loadConfig } from "../../world-model-core/src/config.js";
import { decideProjection } from "../../observation-model/src/fusion.js";
import { createWorldEvent } from "../../event-model/src/events.js";
import { mapObservation } from "./row-mappers.js";
import { insertEvent } from "./world-repository.js";
import { withTransaction } from "./db.js";

export interface ProjectionResult {
  observationId: string;
  decision: ProjectionDecision;
  worldVersion: number;
  events: WorldEvent[];
}

interface CurrentRow {
  object_type: string;
  observed_at: Date | string | null;
  confidence: number | null;
  source: string | null;
  source_observation_id: string | null;
  version: string | null;
  geometry_json: unknown;
  h3_r7: string | null;
  h3_r8: string | null;
  h3_r9: string | null;
  h3_r10: string | null;
}

interface EvidenceProjectionRef {
  timeSolutionId?: string;
  positionMeasurementId?: string;
  uncertainty: Record<string, unknown>;
}

const TYPE_COUNTER: Record<string, "agent_count" | "vehicle_count" | "sensor_count" | "incident_count"> = {
  Agent: "agent_count",
  Vehicle: "vehicle_count",
  UGV: "vehicle_count",
  UAV: "vehicle_count",
  Device: "sensor_count",
  Sensor: "sensor_count",
  Camera: "sensor_count",
  Incident: "incident_count",
  Alert: "incident_count"
};

export class ProjectionProcessor {
  private readonly config = loadConfig();

  constructor(private readonly pool: pg.Pool) {}

  async process(observationId: string): Promise<ProjectionResult> {
    return withTransaction(this.pool, async (client) => {
      const observationResult = await client.query(
        `SELECT o.*,CASE WHEN o.geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(o.geometry)::jsonb END AS geometry_json,
                evidence.time_solution_id,evidence.position_measurement_id,evidence.uncertainty_json
         FROM world_observation o
         LEFT JOIN LATERAL (
           SELECT ts.time_solution_id,pm.measurement_id AS position_measurement_id,
                  jsonb_strip_nulls(jsonb_build_object(
                    'model',pm.accuracy_model,'accuracyRadiusM',pm.accuracy_radius_m,
                    'horizontalStddevM',pm.horizontal_stddev_m,'confidenceLevel',pm.accuracy_confidence,
                    'timeUncertaintySeconds',ts.uncertainty_seconds
                  )) AS uncertainty_json
           FROM observation_time_solution ts
           LEFT JOIN measurement m ON m.time_solution_id=ts.time_solution_id AND m.result_kind='POSITION'
           LEFT JOIN position_measurement pm ON pm.measurement_id=m.measurement_id
           WHERE ts.observation_id=o.observation_id
           ORDER BY ts.created_at DESC,m.created_at DESC LIMIT 1
         ) evidence ON true
         WHERE o.observation_id=$1 FOR UPDATE OF o`,
        [observationId]
      );
      const observationRow = observationResult.rows[0] as Record<string, unknown> | undefined;
      if (!observationRow) throw new Error(`observation not found: ${observationId}`);
      const observation = mapObservation(observationRow);
      if (observationRow.projected_at) {
        await this.completeQueue(client, observationId);
        return {
          observationId,
          decision: { apply: false, reason: "superseded" },
          worldVersion: Number(observationRow.world_version ?? 0),
          events: []
        };
      }
      if (observationRow.entity_binding_status === "CANDIDATE") {
        await this.completeQueue(client,observationId);
        return {
          observationId,
          decision: { apply: false,reason: "candidate-unresolved" },
          worldVersion: await this.sequenceValue(client),
          events: []
        };
      }

      const created = await this.ensureObject(client, observation, String(observationRow.data_scope_key));
      const currentRow = await this.currentRow(client, observation.subject.id);
      const current = toCurrentProjection(currentRow);
      const decision = decideProjection(current, observation, {
        sourcePriorities: this.config.sourcePriorities,
        conflictWindowMs: 5_000,
        maxOutOfOrderMs: this.config.maxLateArrivalMs
      });
      const point = observation.geometry?.type === "Point" ? observation.geometry : undefined;
      const h3 = point ? await this.projectPointToH3(client, point) : undefined;
      const evidence: EvidenceProjectionRef = {
        ...(observationRow.time_solution_id ? { timeSolutionId: String(observationRow.time_solution_id) } : {}),
        ...(observationRow.position_measurement_id ? { positionMeasurementId: String(observationRow.position_measurement_id) } : {}),
        uncertainty: (observationRow.uncertainty_json as Record<string, unknown> | undefined) ?? {}
      };

      const version = decision.apply
        ? await this.applyState(client, observation, point, h3, evidence)
        : Number(currentRow?.version ?? (await this.sequenceValue(client)));

      if (point && h3) {
        await this.incrementObservationSituation(client, observation, h3, version);
      }

      const events: WorldEvent[] = [];
      if (decision.apply) {
        if (created) {
          events.push(createWorldEvent({
            eventType: "ObjectCreated",
            subject: observation.subject,
            worldVersion: version,
            correlationId: observation.correlationId,
            causationId: observation.observationId,
            ...(observation.geometry ? { geometry: observation.geometry } : {}),
            payload: { createdFromObservation: true }
          }));
        }

        events.push(createWorldEvent({
          eventType: point ? "ObjectMoved" : "ObjectStateChanged",
          subject: observation.subject,
          worldVersion: version,
          correlationId: observation.correlationId,
          causationId: observation.observationId,
          ...(observation.geometry ? { geometry: observation.geometry } : {}),
          timestamp: observation.observedAt,
          payload: {
            observationType: observation.observationType,
            sourceObservationId: observation.observationId,
            source: observation.source,
            confidence: observation.confidence,
            fusionDecision: decision.reason
          }
        }));

        if (point && h3) {
          await this.moveObjectSituation(client, observation.subject.type, currentRow, h3, version);
          events.push(...await this.updateGeofences(client, observation, point, version));
        }
      }

      if (point) {
        events.push(createWorldEvent({
          eventType: "TrajectoryUpdated",
          subject: observation.subject,
          worldVersion: version,
          correlationId: observation.correlationId,
          causationId: observation.observationId,
          geometry: point,
          timestamp: observation.observedAt,
          payload: { observationId: observation.observationId }
        }));
      }

      for (const event of events) await insertEvent(client, event);
      await client.query(
        `UPDATE world_observation
         SET status = $2, projected_at = clock_timestamp(), rejection_reason = $3
         WHERE observation_id = $1`,
        [observationId, decision.apply ? "projected" : "superseded", decision.apply ? null : decision.reason]
      );
      await this.completeQueue(client, observationId);
      return { observationId, decision, worldVersion: version, events };
    });
  }

  private async ensureObject(
    client: pg.PoolClient, observation: ObservationEnvelope, dataScopeKey: string
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO world_object (id, object_type, properties, data_scope_key)
       VALUES ($1, $2, '{}'::jsonb, $3) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [observation.subject.id, observation.subject.type, dataScopeKey]
    );
    const owner = await client.query<{ data_scope_key: string }>(
      "SELECT data_scope_key FROM world_object WHERE id=$1",[observation.subject.id]
    );
    if (owner.rows[0]?.data_scope_key !== dataScopeKey) {
      throw Object.assign(new Error(`world object ${observation.subject.id} belongs to another data scope`), {
        statusCode: 409, code: "WORLD_OBJECT_SCOPE_CONFLICT"
      });
    }
    await client.query(
      `UPDATE entity_binding SET world_object_id=$1
       WHERE evidence_observation_id=$2 AND world_object_id IS NULL
         AND binding_status IN ('DECLARED','CONFIRMED')`,
      [observation.subject.id,observation.observationId]
    );
    await client.query(
      `UPDATE mobility_tracklet t SET world_object_id=$1
       FROM entity_binding eb
       WHERE eb.evidence_observation_id=$2
         AND eb.binding_status IN ('DECLARED','CONFIRMED')
         AND t.data_scope_key=eb.data_scope_key AND t.source_key=eb.source_key
         AND t.tracker_session_key=eb.tracker_session_key
         AND t.source_local_target_id=eb.source_local_target_id
         AND t.world_object_id IS DISTINCT FROM $1`,
      [observation.subject.id,observation.observationId]
    );
    return Boolean(result.rowCount);
  }

  private async projectPointToH3(client: pg.PoolClient, point: PointGeometry): Promise<H3Projection> {
    const [longitude, latitude] = point.coordinates;
    const result = await client.query<{ r7: string; r8: string; r9: string; r10: string }>(
      `WITH point AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geometry)
       SELECT h3_latlng_to_cell(geometry, 7)::text AS r7,
              h3_latlng_to_cell(geometry, 8)::text AS r8,
              h3_latlng_to_cell(geometry, 9)::text AS r9,
              h3_latlng_to_cell(geometry, 10)::text AS r10
       FROM point`,
      [longitude, latitude]
    );
    const row = result.rows[0];
    if (!row) throw new Error("h3-pg failed to project point");
    return row;
  }

  private async currentRow(client: pg.PoolClient, objectId: string): Promise<CurrentRow | undefined> {
    const result = await client.query<CurrentRow>(
      `SELECT o.object_type, s.observed_at, s.confidence, s.source, s.source_observation_id,
              s.version::text, CASE WHEN g.geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(g.geometry)::jsonb END AS geometry_json,
              g.h3_r7, g.h3_r8, g.h3_r9, g.h3_r10
       FROM world_object o
       LEFT JOIN world_object_state s ON s.object_id = o.id
       LEFT JOIN world_object_geometry g ON g.object_id = o.id
       WHERE o.id = $1 FOR UPDATE OF o`,
      [objectId]
    );
    return result.rows[0];
  }

  private async applyState(
    client: pg.PoolClient,
    observation: ObservationEnvelope,
    point: PointGeometry | undefined,
    h3: H3Projection | undefined,
    evidence: EvidenceProjectionRef
  ): Promise<number> {
    const positionState = point
      ? {
          position: {
            longitude: point.coordinates[0],
            latitude: point.coordinates[1],
            ...(point.coordinates[2] === undefined ? {} : { altitude: point.coordinates[2] })
          }
        }
      : {};
    const state = { ...observation.value, ...positionState, lastObservationType: observation.observationType };
    const result = await client.query<{ version: string }>(
      `INSERT INTO world_object_state (
         object_id, state, confidence, observed_at, received_at, source,
         source_observation_id,version,updated_at,time_solution_id,position_measurement_id,
         projection_policy_version,uncertainty_summary,evidence_kind
       ) VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,nextval('world_version_seq'),clock_timestamp(),$8,$9,
                 'gowm-projection-v1.2',$10::jsonb,'CANONICAL_EVIDENCE')
       ON CONFLICT (object_id) DO UPDATE SET
         state = world_object_state.state || EXCLUDED.state,
         confidence = EXCLUDED.confidence, observed_at = EXCLUDED.observed_at,
         received_at = EXCLUDED.received_at, source = EXCLUDED.source,
         source_observation_id = EXCLUDED.source_observation_id,
         version = EXCLUDED.version,updated_at=clock_timestamp(),
         time_solution_id=EXCLUDED.time_solution_id,position_measurement_id=EXCLUDED.position_measurement_id,
         projection_policy_version=EXCLUDED.projection_policy_version,
         uncertainty_summary=EXCLUDED.uncertainty_summary,evidence_kind=EXCLUDED.evidence_kind
       RETURNING version::text`,
      [
        observation.subject.id, JSON.stringify(state), observation.confidence,
        observation.observedAt,observation.receivedAt,observation.source,observation.observationId,
        evidence.timeSolutionId ?? null,evidence.positionMeasurementId ?? null,JSON.stringify(evidence.uncertainty)
      ]
    );
    const version = Number(result.rows[0]?.version ?? 0);
    if (observation.geometry && h3) {
      await client.query(
        `INSERT INTO world_object_geometry (
           object_id, geometry, h3_r7, h3_r8, h3_r9, h3_r10, observed_at, updated_at
         ) VALUES (
           $1, ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($2::jsonb)), 4326), $3, $4, $5, $6, $7, clock_timestamp()
         ) ON CONFLICT (object_id) DO UPDATE SET
           geometry = EXCLUDED.geometry, h3_r7 = EXCLUDED.h3_r7, h3_r8 = EXCLUDED.h3_r8,
           h3_r9 = EXCLUDED.h3_r9, h3_r10 = EXCLUDED.h3_r10,
           observed_at = EXCLUDED.observed_at, updated_at = clock_timestamp()`,
        [observation.subject.id, JSON.stringify(observation.geometry), h3.r7, h3.r8, h3.r9, h3.r10, observation.observedAt]
      );
    }
    return version;
  }

  private async incrementObservationSituation(
    client: pg.PoolClient,
    observation: ObservationEnvelope,
    h3: H3Projection,
    version: number
  ): Promise<void> {
    for (const [resolution, index] of h3Entries(h3)) {
      await client.query(
        `INSERT INTO situation_cell (h3_index, resolution, observation_count, last_observed_at, world_version)
         VALUES ($1, $2, 1, $3, $4)
         ON CONFLICT (h3_index, resolution) DO UPDATE SET
           observation_count = situation_cell.observation_count + 1,
           last_observed_at = GREATEST(situation_cell.last_observed_at, EXCLUDED.last_observed_at),
           world_version = GREATEST(situation_cell.world_version, EXCLUDED.world_version),
           updated_at = clock_timestamp()`,
        [index, resolution, observation.observedAt, version]
      );
      await client.query(
        `INSERT INTO situation_cell_observer (
           h3_index, resolution, observer_id, first_observed_at, last_observed_at
         ) VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (h3_index, resolution, observer_id) DO UPDATE SET
           last_observed_at = GREATEST(situation_cell_observer.last_observed_at, EXCLUDED.last_observed_at),
           observation_count = situation_cell_observer.observation_count + 1`,
        [index, resolution, observation.observer.id, observation.observedAt]
      );
      await client.query(
        `UPDATE situation_cell SET unique_observer_count = (
           SELECT count(*) FROM situation_cell_observer
           WHERE h3_index = $1 AND resolution = $2
         ) WHERE h3_index = $1 AND resolution = $2`,
        [index, resolution]
      );
    }
  }

  private async moveObjectSituation(
    client: pg.PoolClient,
    objectType: string,
    current: CurrentRow | undefined,
    next: H3Projection,
    version: number
  ): Promise<void> {
    const counter = TYPE_COUNTER[objectType];
    if (!counter) return;
    const previous: H3Projection = {
      ...(current?.h3_r7 ? { r7: current.h3_r7 } : {}),
      ...(current?.h3_r8 ? { r8: current.h3_r8 } : {}),
      ...(current?.h3_r9 ? { r9: current.h3_r9 } : {}),
      ...(current?.h3_r10 ? { r10: current.h3_r10 } : {})
    };
    const previousByResolution = new Map(h3Entries(previous));
    for (const [resolution, index] of h3Entries(next)) {
      const oldIndex = previousByResolution.get(resolution);
      if (oldIndex === index) continue;
      if (oldIndex) {
        await client.query(
          `UPDATE situation_cell SET ${counter} = GREATEST(0, ${counter} - 1),
             world_version = GREATEST(world_version, $3), updated_at = clock_timestamp()
           WHERE h3_index = $1 AND resolution = $2`,
          [oldIndex, resolution, version]
        );
      }
      await client.query(
        `INSERT INTO situation_cell (h3_index, resolution, ${counter}, world_version)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (h3_index, resolution) DO UPDATE SET
           ${counter} = situation_cell.${counter} + 1,
           world_version = GREATEST(situation_cell.world_version, EXCLUDED.world_version),
           updated_at = clock_timestamp()`,
        [index, resolution, version]
      );
    }
  }

  private async updateGeofences(
    client: pg.PoolClient,
    observation: ObservationEnvelope,
    point: PointGeometry,
    version: number
  ): Promise<WorldEvent[]> {
    const [lon, lat] = point.coordinates;
    const containedResult = await client.query<{ id: string }>(
      `SELECT o.id FROM world_object o JOIN world_object_geometry g ON g.object_id = o.id
       WHERE o.object_type = ANY(ARRAY['Zone','AOI','Geofence']::text[])
         AND o.deleted_at IS NULL
         AND ST_Covers(g.geometry, ST_SetSRID(ST_MakePoint($1, $2), 4326))`,
      [lon, lat]
    );
    const existingResult = await client.query<{ area_id: string }>(
      "SELECT area_id FROM object_area_membership WHERE object_id = $1 FOR UPDATE",
      [observation.subject.id]
    );
    const contained = new Set(containedResult.rows.map((row) => row.id));
    const existing = new Set(existingResult.rows.map((row) => row.area_id));
    const events: WorldEvent[] = [];
    for (const areaId of contained) {
      if (existing.has(areaId)) continue;
      await client.query(
        `INSERT INTO object_area_membership (object_id, area_id, entered_at, source_observation_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [observation.subject.id, areaId, observation.observedAt, observation.observationId]
      );
      events.push(createWorldEvent({
        eventType: "ObjectEnteredArea",
        subject: observation.subject,
        worldVersion: version,
        correlationId: observation.correlationId,
        causationId: observation.observationId,
        geometry: point,
        timestamp: observation.observedAt,
        payload: { areaId }
      }));
    }
    for (const areaId of existing) {
      if (contained.has(areaId)) continue;
      await client.query("DELETE FROM object_area_membership WHERE object_id = $1 AND area_id = $2", [observation.subject.id, areaId]);
      events.push(createWorldEvent({
        eventType: "ObjectExitedArea",
        subject: observation.subject,
        worldVersion: version,
        correlationId: observation.correlationId,
        causationId: observation.observationId,
        geometry: point,
        timestamp: observation.observedAt,
        payload: { areaId }
      }));
    }
    return events;
  }

  private async sequenceValue(client: pg.PoolClient): Promise<number> {
    const result = await client.query<{ value: string }>("SELECT last_value::text AS value FROM world_version_seq");
    return Number(result.rows[0]?.value ?? 0);
  }

  private async completeQueue(client: pg.PoolClient, observationId: string): Promise<void> {
    await client.query(
      `UPDATE projection_queue SET processed_at = clock_timestamp(), locked_at = NULL, locked_by = NULL
       WHERE observation_id = $1`,
      [observationId]
    );
  }
}

function toCurrentProjection(row: CurrentRow | undefined): CurrentProjection | undefined {
  if (!row?.observed_at || row.confidence === null || !row.source || !row.source_observation_id) return undefined;
  return {
    observedAt: new Date(row.observed_at).toISOString(),
    confidence: Number(row.confidence),
    source: row.source,
    sourceObservationId: row.source_observation_id
  };
}

function h3Entries(h3: H3Projection): Array<[number, string]> {
  return [
    h3.r7 ? [7, h3.r7] : undefined,
    h3.r8 ? [8, h3.r8] : undefined,
    h3.r9 ? [9, h3.r9] : undefined,
    h3.r10 ? [10, h3.r10] : undefined
  ].filter((entry): entry is [number, string] => entry !== undefined);
}
