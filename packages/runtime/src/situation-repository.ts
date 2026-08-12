import type pg from "pg";
import type { Geometry, SituationCell } from "../../world-model-core/src/types.js";
import { h3Resolution } from "../../h3-situation/src/h3.js";
import { mapSituationCell } from "./row-mappers.js";

const SCORE_COLUMNS: Record<string, string> = {
  activity: "derived_activity_score",
  risk: "derived_risk_score",
  coverage: "derived_coverage_score",
  freshness: "last_observed_at",
  observations: "observation_count"
};

export class SituationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getCell(index: string): Promise<SituationCell | undefined> {
    const result = await this.pool.query("SELECT * FROM situation_cell_scored WHERE h3_index = $1::h3index", [index]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapSituationCell(row) : undefined;
  }

  async getCells(indexes: string[]): Promise<SituationCell[]> {
    if (!indexes.length) return [];
    const result = await this.pool.query(
      "SELECT * FROM situation_cell_scored WHERE h3_index = ANY($1::h3index[]) ORDER BY resolution, h3_index",
      [indexes]
    );
    return result.rows.map((row) => mapSituationCell(row as Record<string, unknown>));
  }

  async areaCells(area: Geometry, resolution: number): Promise<SituationCell[]> {
    const indexes = await this.areaH3Indexes(area, resolution);
    const existing = new Map((await this.getCells(indexes)).map((cell) => [cell.h3Index, cell]));
    return indexes.map((index) => existing.get(index) ?? emptyCell(index, resolution));
  }

  async neighbors(index: string, ring = 1): Promise<SituationCell[]> {
    const result = await this.pool.query<{ h3_index: string }>(
      "SELECT cell::text AS h3_index FROM h3_grid_disk($1::h3index, $2) AS cell ORDER BY cell",
      [index, ring]
    );
    const indexes = result.rows.map((row) => row.h3_index);
    const existing = new Map((await this.getCells(indexes)).map((cell) => [cell.h3Index, cell]));
    return indexes.map((cellIndex) => existing.get(cellIndex) ?? emptyCell(cellIndex, h3Resolution(index)));
  }

  async hierarchy(index: string, targetResolution: number): Promise<{ parent?: string; children?: string[] }> {
    const current = h3Resolution(index);
    if (targetResolution < current) {
      const result = await this.pool.query<{ parent: string }>(
        "SELECT h3_cell_to_parent($1::h3index, $2)::text AS parent",
        [index, targetResolution]
      );
      const parent = result.rows[0]?.parent;
      if (!parent) throw new Error("h3-pg did not return a parent cell");
      return { parent };
    }
    if (targetResolution > current) {
      const result = await this.pool.query<{ child: string }>(
        "SELECT child::text AS child FROM h3_cell_to_children($1::h3index, $2) AS child ORDER BY child",
        [index, targetResolution]
      );
      return { children: result.rows.map((row) => row.child) };
    }
    return { parent: index, children: [index] };
  }

  async ranked(options: {
    resolution: number;
    metric: string;
    order: "ASC" | "DESC";
    limit: number;
    parentCell?: string;
  }): Promise<SituationCell[]> {
    const scoreColumn = SCORE_COLUMNS[options.metric];
    if (!scoreColumn) throw new Error(`unsupported situation metric: ${options.metric}`);
    if (options.parentCell) {
      const parentResolution = h3Resolution(options.parentCell);
      if (options.resolution < parentResolution) throw new Error("ranked target resolution cannot be coarser than parentCell");
      if (options.resolution - parentResolution > 3) throw new Error("ranked drill-down is limited to three H3 resolution levels");
    }
    const result = await this.pool.query(
      `SELECT * FROM situation_cell_scored
       WHERE resolution = $1
         AND ($3::h3index IS NULL
              OR CASE
                   WHEN resolution >= h3_get_resolution($3::h3index)
                   THEN h3_cell_to_parent(h3_index, h3_get_resolution($3::h3index)) = $3::h3index
                   ELSE false
                 END)
       ORDER BY ${scoreColumn} ${options.order} NULLS LAST, h3_index LIMIT $2`,
      [options.resolution, options.limit, options.parentCell ?? null]
    );
    return result.rows.map((row) => mapSituationCell(row as Record<string, unknown>));
  }

  private async areaH3Indexes(area: Geometry, resolution: number): Promise<string[]> {
    const geometryJson = JSON.stringify(area);
    if (area.type === "Point") {
      const result = await this.pool.query<{ h3_index: string }>(
        `SELECT h3_latlng_to_cell(
           ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb), 4326), $2
         )::text AS h3_index`,
        [geometryJson, resolution]
      );
      return result.rows.map((row) => row.h3_index);
    }
    if (area.type === "Polygon" || area.type === "MultiPolygon") {
      const result = await this.pool.query<{ h3_index: string }>(
        `SELECT cell::text AS h3_index
         FROM h3_polygon_to_cells(
           ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb), 4326), $2
         ) AS cell ORDER BY cell`,
        [geometryJson, resolution]
      );
      return result.rows.map((row) => row.h3_index);
    }
    const result = await this.pool.query<{ h3_index: string }>(
      `SELECT DISTINCT h3_latlng_to_cell(dumped.geom, $2)::text AS h3_index
       FROM ST_DumpPoints(ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb), 4326)) AS dumped
       ORDER BY h3_index`,
      [geometryJson, resolution]
    );
    return result.rows.map((row) => row.h3_index);
  }
}

function emptyCell(index: string, resolution: number): SituationCell {
  return {
    h3Index: index,
    resolution,
    metrics: {
      agentCount: 0, vehicleCount: 0, sensorCount: 0, incidentCount: 0,
      observationCount: 0, riskScore: 0, coverageScore: 0, activityScore: 0, freshnessScore: 0
    },
    updatedAt: new Date(0).toISOString(),
    worldVersion: 0
  };
}
