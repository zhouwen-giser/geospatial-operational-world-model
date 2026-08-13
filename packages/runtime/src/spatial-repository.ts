import type pg from "pg";
import type { Geometry, LineStringGeometry, PointGeometry, WorldObject } from "../../world-model-core/src/types.js";
import { loadConfig } from "../../world-model-core/src/config.js";
import { mapWorldObject } from "./row-mappers.js";

const SPATIAL_FIELDS = `
  SELECT o.id, o.object_type, o.subtype, o.properties,
         s.state, s.confidence, s.observed_at, s.received_at, s.source,
         s.source_observation_id, s.version, s.updated_at,
         ST_AsGeoJSON(g.geometry)::jsonb AS geometry_json,
         g.h3_r7, g.h3_r8, g.h3_r9, g.h3_r10`;

const SPATIAL_FROM = `
  FROM world_object o
  JOIN world_object_state s ON s.object_id = o.id
  JOIN world_object_geometry g ON g.object_id = o.id
`;

export interface SpatialObjectResult {
  object: WorldObject;
  distanceM?: number;
}

export class SpatialRepository {
  private readonly staleAfterMs = loadConfig().staleAfterMs;

  constructor(private readonly pool: pg.Pool) {}

  async nearby(input: {
    point: PointGeometry;
    objectTypes?: string[];
    radiusM: number;
    filter?: Record<string, unknown>;
    limit: number;
  }): Promise<SpatialObjectResult[]> {
    const [lon, lat] = input.point.coordinates;
    const result = await this.pool.query(
      `${SPATIAL_FIELDS},
       ST_Distance(g.geometry::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
       ${SPATIAL_FROM}
       WHERE o.deleted_at IS NULL
         AND ST_DWithin(g.geometry::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
         AND ($4::text[] IS NULL OR o.object_type = ANY($4::text[]))
         AND ($5::jsonb = '{}'::jsonb OR s.state @> $5::jsonb OR o.properties @> $5::jsonb)
       ORDER BY distance_m, o.id LIMIT $6`,
      [lon, lat, input.radiusM, input.objectTypes?.length ? input.objectTypes : null, JSON.stringify(input.filter ?? {}), input.limit]
    );
    return result.rows.map((row) => ({
      object: mapWorldObject(row as Record<string, unknown>, this.staleAfterMs),
      distanceM: Number(row.distance_m)
    }));
  }

  async nearest(input: { point: PointGeometry; objectTypes?: string[]; filter?: Record<string, unknown>; limit: number }): Promise<SpatialObjectResult[]> {
    const [lon, lat] = input.point.coordinates;
    const result = await this.pool.query(
      `${SPATIAL_FIELDS},
       ST_Distance(g.geometry::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
       ${SPATIAL_FROM}
       WHERE o.deleted_at IS NULL
         AND ($3::text[] IS NULL OR o.object_type = ANY($3::text[]))
         AND ($4::jsonb = '{}'::jsonb OR s.state @> $4::jsonb OR o.properties @> $4::jsonb)
       ORDER BY g.geometry <-> ST_SetSRID(ST_MakePoint($1, $2), 4326), o.id LIMIT $5`,
      [lon, lat, input.objectTypes?.length ? input.objectTypes : null, JSON.stringify(input.filter ?? {}), input.limit]
    );
    return result.rows.map((row) => ({ object: mapWorldObject(row as Record<string, unknown>, this.staleAfterMs), distanceM: Number(row.distance_m) }));
  }

  async within(input: { area: Geometry; objectTypes?: string[]; filter?: Record<string, unknown>; limit: number }): Promise<WorldObject[]> {
    const result = await this.pool.query(
      `${SPATIAL_FIELDS} ${SPATIAL_FROM}
       WHERE o.deleted_at IS NULL
         AND ST_Covers(ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($1::jsonb)), 4326), g.geometry)
         AND ($2::text[] IS NULL OR o.object_type = ANY($2::text[]))
         AND ($3::jsonb = '{}'::jsonb OR s.state @> $3::jsonb OR o.properties @> $3::jsonb)
       ORDER BY o.id LIMIT $4`,
      [JSON.stringify(input.area), input.objectTypes?.length ? input.objectTypes : null, JSON.stringify(input.filter ?? {}), input.limit]
    );
    return result.rows.map((row) => mapWorldObject(row as Record<string, unknown>, this.staleAfterMs));
  }

  async intersections(input: { geometry: Geometry; objectTypes?: string[]; limit: number }): Promise<WorldObject[]> {
    const result = await this.pool.query(
      `${SPATIAL_FIELDS} ${SPATIAL_FROM}
       WHERE o.deleted_at IS NULL
         AND ST_Intersects(g.geometry, ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($1::jsonb)), 4326))
         AND ($2::text[] IS NULL OR o.object_type = ANY($2::text[]))
       ORDER BY o.id LIMIT $3`,
      [JSON.stringify(input.geometry), input.objectTypes?.length ? input.objectTypes : null, input.limit]
    );
    return result.rows.map((row) => mapWorldObject(row as Record<string, unknown>, this.staleAfterMs));
  }

  async nearRoute(input: { route: LineStringGeometry; bufferM: number; objectTypes?: string[]; limit: number }): Promise<SpatialObjectResult[]> {
    const result = await this.pool.query(
      `${SPATIAL_FIELDS},
       ST_Distance(g.geometry::geography, ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($1::jsonb)), 4326)::geography) AS distance_m
       ${SPATIAL_FROM}
       WHERE o.deleted_at IS NULL
         AND ST_DWithin(g.geometry::geography, ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($1::jsonb)), 4326)::geography, $2)
         AND ($3::text[] IS NULL OR o.object_type = ANY($3::text[]))
       ORDER BY distance_m, o.id LIMIT $4`,
      [JSON.stringify(input.route), input.bufferM, input.objectTypes?.length ? input.objectTypes : null, input.limit]
    );
    return result.rows.map((row) => ({ object: mapWorldObject(row as Record<string, unknown>, this.staleAfterMs), distanceM: Number(row.distance_m) }));
  }

  async containingAreas(point: PointGeometry, limit = 100): Promise<WorldObject[]> {
    const [lon, lat] = point.coordinates;
    const result = await this.pool.query(
      `${SPATIAL_FIELDS} ${SPATIAL_FROM}
       WHERE o.deleted_at IS NULL
         AND o.object_type = ANY(ARRAY['Zone','AOI','Geofence']::text[])
         AND ST_Covers(g.geometry, ST_SetSRID(ST_MakePoint($1, $2), 4326))
       ORDER BY ST_Area(g.geometry::geography), o.id LIMIT $3`,
      [lon, lat, limit]
    );
    return result.rows.map((row) => mapWorldObject(row as Record<string, unknown>, this.staleAfterMs));
  }

  async distance(a: PointGeometry, b: PointGeometry): Promise<number> {
    const result = await this.pool.query<{ distance_m: number }>(
      `SELECT ST_Distance(
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
         ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
       ) AS distance_m`,
      [a.coordinates[0], a.coordinates[1], b.coordinates[0], b.coordinates[1]]
    );
    return Number(result.rows[0]?.distance_m ?? 0);
  }

  async areaSummary(area: Geometry): Promise<Record<string, number>> {
    const result = await this.pool.query<{ object_type: string; count: string }>(
      `SELECT o.object_type, count(*)::text AS count
       FROM world_object o JOIN world_object_geometry g ON g.object_id = o.id
       WHERE o.deleted_at IS NULL
         AND ST_Covers(ST_SetSRID(ST_Force2D(ST_GeomFromGeoJSON($1::jsonb)), 4326), g.geometry)
       GROUP BY o.object_type ORDER BY o.object_type`,
      [JSON.stringify(area)]
    );
    return Object.fromEntries(result.rows.map((row) => [row.object_type, Number(row.count)]));
  }
}
