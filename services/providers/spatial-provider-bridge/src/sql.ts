import { ProviderProtocolError } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { SpatialCursorPayload } from "./cursor.js";
import type { SpatialOperationId } from "./schemas.js";

export type SpatialQueryKind = "OBJECT_PAGE" | "COUNT" | "SUMMARY" | "JOIN" | "AGGREGATE";

export interface BuiltSpatialQuery {
  text: string;
  values: unknown[];
  kind: SpatialQueryKind;
  sort: "id" | "distance";
  rowLimit: number;
}

export interface SpatialQueryLimits {
  maximumRows: number;
  maximumCandidates: number;
  maximumEvidenceReferences: number;
}

class Parameters {
  readonly values: unknown[] = [];

  add(value: unknown, cast?: string): string {
    this.values.push(value);
    const parameter = `$${this.values.length}`;
    return cast === undefined ? parameter : `${parameter}::${cast}`;
  }
}

export function buildSpatialQuery(
  operationId: SpatialOperationId,
  rawInput: unknown,
  cursor: SpatialCursorPayload | undefined,
  limits: SpatialQueryLimits
): BuiltSpatialQuery {
  const input = asRecord(rawInput);
  assertTimeRange(input);
  switch (operationId) {
    case "spatial.find-nearby": return distancePointQuery(operationId, input, cursor, limits, true);
    case "spatial.find-nearest": return distancePointQuery(operationId, input, cursor, limits, false);
    case "spatial.find-in-area": return geometryObjectPage(operationId, input, cursor, limits, "ST_Covers(q.geom, co.geometry_wgs84)");
    case "spatial.find-intersections": return geometryObjectPage(operationId, input, cursor, limits, "ST_Intersects(co.geometry_wgs84, q.geom)");
    case "spatial.find-near-route": return nearRouteQuery(input, cursor, limits);
    case "spatial.find-containing-area": return containingAreaQuery(input, cursor, limits);
    case "spatial.count-in-area": return countQuery(input, limits);
    case "spatial.summarize-area": return summaryQuery(input, limits);
    case "spatial.join": return joinQuery(input, limits);
    case "spatial.aggregate": return aggregateQuery(input, limits);
  }
}

function distancePointQuery(
  operationId: "spatial.find-nearby" | "spatial.find-nearest",
  input: Record<string, unknown>,
  cursor: SpatialCursorPayload | undefined,
  limits: SpatialQueryLimits,
  bounded: boolean
): BuiltSpatialQuery {
  const parameters = new Parameters();
  const [longitudeValue, latitudeValue] = locationCoordinates(input.location);
  const longitude = parameters.add(longitudeValue, "double precision");
  const latitude = parameters.add(latitudeValue, "double precision");
  const includeGeometry = parameters.add(input.includeGeometry === true, "boolean");
  const distance = "ST_Distance(co.geography_wgs84, q.geog, true)";
  const clauses = commonObjectClauses(input, "co", parameters);
  clauses.push("co.geography_wgs84 IS NOT NULL");
  const radius = bounded ? input.radiusM : input.maxDistanceM;
  if (radius !== undefined) {
    clauses.push(`ST_DWithin(co.geography_wgs84, q.geog, ${parameters.add(radius, "double precision")}, true)`);
  }
  if (cursor) {
    const cursorDistance = parameters.add(cursor.distanceM, "double precision");
    const cursorId = parameters.add(cursor.id, "text");
    clauses.push(`(${distance} > ${cursorDistance} OR (${distance} = ${cursorDistance} AND co.reference_key->>'id' > ${cursorId}))`);
  }
  const candidateLimit = parameters.add(limits.maximumCandidates + 1, "integer");
  const rowLimit = requestedLimit(input, limits.maximumRows);
  const fetchLimit = parameters.add(rowLimit + 1, "integer");
  const candidateOrder = bounded
    ? `${distance}, co.reference_key->>'id'`
    : `co.geography_wgs84 <-> q.geog, co.reference_key->>'id'`;
  return {
    kind: "OBJECT_PAGE",
    sort: "distance",
    rowLimit,
    values: parameters.values,
    text: `/* ${operationId} */
WITH q AS (
  SELECT ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography AS geog
), candidates AS MATERIALIZED (
  SELECT ${currentObjectColumns("co", includeGeometry)},
         ${distance} AS distance_m,
         co.reference_key->>'id' AS reference_id
  FROM gowm_spatial_v1.current_object co CROSS JOIN q
  ${where(clauses)}
  ORDER BY ${candidateOrder}
  LIMIT ${candidateLimit}
)
SELECT candidates.*,
       (SELECT count(*)::integer FROM candidates) AS candidate_count
FROM candidates
ORDER BY distance_m, reference_id
LIMIT ${fetchLimit}`
  };
}

function geometryObjectPage(
  operationId: "spatial.find-in-area" | "spatial.find-intersections",
  input: Record<string, unknown>,
  cursor: SpatialCursorPayload | undefined,
  limits: SpatialQueryLimits,
  predicate: string
): BuiltSpatialQuery {
  const parameters = new Parameters();
  const geometry = parameters.add(JSON.stringify(input.geometry), "json");
  const includeGeometry = parameters.add(input.includeGeometry === true, "boolean");
  const clauses = commonObjectClauses(input, "co", parameters);
  clauses.push("co.geometry_wgs84 IS NOT NULL", predicate);
  addCandidateReferenceClause(input, clauses, "co", parameters, limits.maximumCandidates);
  addIdCursor(clauses, cursor, "co", parameters);
  const candidateLimit = parameters.add(limits.maximumCandidates + 1, "integer");
  const rowLimit = requestedLimit(input, limits.maximumRows);
  const fetchLimit = parameters.add(rowLimit + 1, "integer");
  const catalogFeatureView = input.candidateReferences === undefined
    ? "gowm_spatial_v1.catalog_feature"
    : "gowm_spatial_v1.catalog_feature_reference";
  const candidateSource = operationId === "spatial.find-intersections"
    ? `(SELECT ${intersectionSourceColumns("object_source")}
       FROM gowm_spatial_v1.current_object object_source
       UNION
       SELECT ${intersectionSourceColumns("feature_source")}
       FROM ${catalogFeatureView} feature_source) co`
    : "gowm_spatial_v1.current_object co";
  return {
    kind: "OBJECT_PAGE",
    sort: "id",
    rowLimit,
    values: parameters.values,
    text: `/* ${operationId} */
WITH q AS (
  SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geometry}), 4326) AS geom
), candidates AS MATERIALIZED (
  SELECT ${currentObjectColumns("co", includeGeometry)},
         co.reference_key->>'id' AS reference_id
  FROM ${candidateSource} CROSS JOIN q
  ${where(clauses)}
  ORDER BY co.reference_key->>'id'
  LIMIT ${candidateLimit}
)
SELECT candidates.*,
       (SELECT count(*)::integer FROM candidates) AS candidate_count
FROM candidates
ORDER BY reference_id
LIMIT ${fetchLimit}`
  };
}

function nearRouteQuery(
  input: Record<string, unknown>,
  cursor: SpatialCursorPayload | undefined,
  limits: SpatialQueryLimits
): BuiltSpatialQuery {
  const parameters = new Parameters();
  const route = parameters.add(JSON.stringify(input.route), "json");
  const distanceLimit = parameters.add(input.distanceM, "double precision");
  const includeGeometry = parameters.add(input.includeGeometry === true, "boolean");
  const distance = "ST_Distance(co.geography_wgs84, q.geom::geography, true)";
  const clauses = commonObjectClauses(input, "co", parameters);
  clauses.push("co.geography_wgs84 IS NOT NULL", `ST_DWithin(co.geography_wgs84, q.geom::geography, ${distanceLimit}, true)`);
  if (cursor) {
    const cursorDistance = parameters.add(cursor.distanceM, "double precision");
    const cursorId = parameters.add(cursor.id, "text");
    clauses.push(`(${distance} > ${cursorDistance} OR (${distance} = ${cursorDistance} AND co.reference_key->>'id' > ${cursorId}))`);
  }
  const candidateLimit = parameters.add(limits.maximumCandidates + 1, "integer");
  const rowLimit = requestedLimit(input, limits.maximumRows);
  const fetchLimit = parameters.add(rowLimit + 1, "integer");
  return {
    kind: "OBJECT_PAGE",
    sort: "distance",
    rowLimit,
    values: parameters.values,
    text: `/* spatial.find-near-route */
WITH q AS (
  SELECT ST_SetSRID(ST_GeomFromGeoJSON(${route}), 4326) AS geom
), candidates AS MATERIALIZED (
  SELECT ${currentObjectColumns("co", includeGeometry)},
         ${distance} AS distance_m,
         co.reference_key->>'id' AS reference_id
  FROM gowm_spatial_v1.current_object co CROSS JOIN q
  ${where(clauses)}
  ORDER BY distance_m, co.reference_key->>'id'
  LIMIT ${candidateLimit}
)
SELECT candidates.*,
       (SELECT count(*)::integer FROM candidates) AS candidate_count
FROM candidates
ORDER BY distance_m, reference_id
LIMIT ${fetchLimit}`
  };
}

function containingAreaQuery(
  input: Record<string, unknown>,
  cursor: SpatialCursorPayload | undefined,
  limits: SpatialQueryLimits
): BuiltSpatialQuery {
  const parameters = new Parameters();
  const geometry = parameters.add(JSON.stringify(input.geometry), "json");
  const includeGeometry = parameters.add(input.includeGeometry === true, "boolean");
  const clauses = ["lf.geometry_wgs84 IS NOT NULL", "ST_Covers(lf.geometry_wgs84, q.geom)"];
  if (Array.isArray(input.layerKeys)) clauses.push(`lf.layer_key = ANY(${parameters.add(input.layerKeys, "text[]")})`);
  if (cursor) clauses.push(`lf.reference_key->>'id' > ${parameters.add(cursor.id, "text")}`);
  const candidateLimit = parameters.add(limits.maximumCandidates + 1, "integer");
  const rowLimit = requestedLimit(input, limits.maximumRows);
  const fetchLimit = parameters.add(rowLimit + 1, "integer");
  return {
    kind: "OBJECT_PAGE",
    sort: "id",
    rowLimit,
    values: parameters.values,
    text: `/* spatial.find-containing-area */
WITH q AS (
  SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geometry}), 4326) AS geom
), candidates AS MATERIALIZED (
  SELECT ${layerColumns("lf", includeGeometry)},
         lf.reference_key->>'id' AS reference_id
  FROM gowm_spatial_v1.layer_feature lf CROSS JOIN q
  ${where(clauses)}
  ORDER BY lf.reference_key->>'id'
  LIMIT ${candidateLimit}
)
SELECT candidates.*,
       (SELECT count(*)::integer FROM candidates) AS candidate_count
FROM candidates
ORDER BY reference_id
LIMIT ${fetchLimit}`
  };
}

function countQuery(input: Record<string, unknown>, limits: SpatialQueryLimits): BuiltSpatialQuery {
  const parameters = new Parameters();
  const geometry = parameters.add(JSON.stringify(input.geometry), "json");
  const clauses = commonObjectClauses(input, "co", parameters);
  clauses.push("co.geometry_wgs84 IS NOT NULL", "ST_Covers(q.geom, co.geometry_wgs84)");
  const candidateLimit = parameters.add(limits.maximumCandidates + 1, "integer");
  const evidenceLimit = parameters.add(limits.maximumEvidenceReferences, "integer");
  return {
    kind: "COUNT",
    sort: "id",
    rowLimit: 1,
    values: parameters.values,
    text: `/* spatial.count-in-area */
WITH q AS (
  SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geometry}), 4326) AS geom
), matched AS MATERIALIZED (
  SELECT co.reference_key, co.reference_key->>'id' AS reference_id,
         co.world_version, co.observed_at
  FROM gowm_spatial_v1.current_object co CROSS JOIN q
  ${where(clauses)}
  ORDER BY co.reference_key->>'id'
  LIMIT ${candidateLimit}
)
SELECT count(*)::integer AS result_count,
       count(*)::integer AS candidate_count,
       COALESCE((
         SELECT jsonb_agg(e.reference_key ORDER BY e.reference_id)
         FROM (SELECT * FROM matched ORDER BY reference_id LIMIT ${evidenceLimit}) e
       ), '[]'::jsonb) AS source_references,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'referenceKey', e.reference_key,
           'worldVersion', e.world_version,
           'observedAt', e.observed_at
         ) ORDER BY e.reference_id)
         FROM (SELECT * FROM matched ORDER BY reference_id LIMIT ${evidenceLimit}) e
       ), '[]'::jsonb) AS evidence_rows
FROM matched`
  };
}

function summaryQuery(input: Record<string, unknown>, limits: SpatialQueryLimits): BuiltSpatialQuery {
  const parameters = new Parameters();
  const geometry = parameters.add(JSON.stringify(input.geometry), "json");
  const groupExpression = summaryGroup(String(input.groupBy));
  const clauses = commonObjectClauses(input, "co", parameters);
  clauses.push("co.geometry_wgs84 IS NOT NULL", "ST_Covers(q.geom, co.geometry_wgs84)");
  const candidateLimit = parameters.add(limits.maximumCandidates + 1, "integer");
  const evidenceLimit = parameters.add(limits.maximumEvidenceReferences, "integer");
  return {
    kind: "SUMMARY",
    sort: "id",
    rowLimit: 1,
    values: parameters.values,
    text: `/* spatial.summarize-area */
WITH q AS (
  SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geometry}), 4326) AS geom
), matched AS MATERIALIZED (
  SELECT co.reference_key, co.reference_key->>'id' AS reference_id,
         co.world_version, co.observed_at, ${groupExpression} AS group_key
  FROM gowm_spatial_v1.current_object co CROSS JOIN q
  ${where(clauses)}
  ORDER BY co.reference_key->>'id'
  LIMIT ${candidateLimit}
), grouped AS (
  SELECT group_key, count(*)::integer AS count
  FROM matched GROUP BY group_key ORDER BY group_key NULLS FIRST
)
SELECT (SELECT count(*)::integer FROM matched) AS total,
       (SELECT count(*)::integer FROM matched) AS candidate_count,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('key', group_key, 'count', count) ORDER BY group_key NULLS FIRST) FROM grouped), '[]'::jsonb) AS groups,
       COALESCE((SELECT jsonb_agg(e.reference_key ORDER BY e.reference_id) FROM (SELECT * FROM matched ORDER BY reference_id LIMIT ${evidenceLimit}) e), '[]'::jsonb) AS source_references,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('referenceKey', e.reference_key, 'worldVersion', e.world_version, 'observedAt', e.observed_at) ORDER BY e.reference_id) FROM (SELECT * FROM matched ORDER BY reference_id LIMIT ${evidenceLimit}) e), '[]'::jsonb) AS evidence_rows`
  };
}

function joinQuery(input: Record<string, unknown>, limits: SpatialQueryLimits): BuiltSpatialQuery {
  const parameters = new Parameters();
  const relation = String(input.relation);
  const leftLimit = Math.min(integer(input.leftLimit, 50), 100);
  const resultLimit = Math.min(integer(input.resultLimit, 500), limits.maximumRows);
  const leftLimitParameter = parameters.add(leftLimit, "integer");
  const leftClauses = objectTypeClause(input.leftObjectTypes, "l", parameters);
  const rightClauses = objectTypeClause(input.rightObjectTypes, "r", parameters);
  rightClauses.push("r.reference_key->>'id' <> l.reference_key->>'id'");
  const candidateLimit = parameters.add(limits.maximumCandidates + 1, "integer");
  const fetchLimit = parameters.add(resultLimit + 1, "integer");
  const pairsSql = relation === "nearest"
    ? nearestPairs(input, parameters, rightClauses, candidateLimit)
    : relatedPairs(relation, input, parameters, rightClauses, candidateLimit);
  return {
    kind: "JOIN",
    sort: "id",
    rowLimit: resultLimit,
    values: parameters.values,
    text: `/* spatial.join */
WITH left_rows AS MATERIALIZED (
  SELECT l.reference_key, l.geometry_wgs84, l.geography_wgs84
  FROM gowm_spatial_v1.current_object l
  ${where(["l.geometry_wgs84 IS NOT NULL", ...leftClauses])}
  ORDER BY l.reference_key->>'id'
  LIMIT ${leftLimitParameter}
), pairs AS MATERIALIZED (
  ${pairsSql}
)
SELECT pairs.*,
       (SELECT count(*)::integer FROM pairs) AS candidate_count
FROM pairs
ORDER BY left_reference_id, rank NULLS LAST, right_reference_id
LIMIT ${fetchLimit}`
  };
}

function nearestPairs(
  input: Record<string, unknown>,
  parameters: Parameters,
  rightClauses: string[],
  candidateLimit: string
): string {
  const nearestK = parameters.add(Math.min(integer(input.nearestK, 1), 20), "integer");
  return `SELECT l.reference_key AS left_reference_key,
         l.reference_key->>'id' AS left_reference_id,
         nearest.right_reference_key,
         nearest.right_reference_id,
         nearest.distance_m,
         nearest.rank
  FROM left_rows l
  CROSS JOIN LATERAL (
    SELECT r.reference_key AS right_reference_key,
           r.reference_key->>'id' AS right_reference_id,
           ST_Distance(l.geography_wgs84, r.geography_wgs84, true) AS distance_m,
           row_number() OVER (ORDER BY r.geography_wgs84 <-> l.geography_wgs84, r.reference_key->>'id')::integer AS rank
    FROM gowm_spatial_v1.current_object r
    ${where(["r.geography_wgs84 IS NOT NULL", ...rightClauses])}
    ORDER BY r.geography_wgs84 <-> l.geography_wgs84, r.reference_key->>'id'
    LIMIT ${nearestK}
  ) nearest
  ORDER BY l.reference_key->>'id', nearest.rank, nearest.right_reference_id
  LIMIT ${candidateLimit}`;
}

function relatedPairs(
  relation: string,
  input: Record<string, unknown>,
  parameters: Parameters,
  rightClauses: string[],
  candidateLimit: string
): string {
  const relationPredicate: Record<string, string> = {
    intersects: "ST_Intersects(l.geometry_wgs84, r.geometry_wgs84)",
    within: "ST_Within(l.geometry_wgs84, r.geometry_wgs84)",
    covers: "ST_Covers(l.geometry_wgs84, r.geometry_wgs84)"
  };
  let predicate = relationPredicate[relation];
  if (relation === "dwithin") {
    predicate = `ST_DWithin(l.geography_wgs84, r.geography_wgs84, ${parameters.add(input.distanceM, "double precision")}, true)`;
  }
  if (!predicate) throw new ProviderProtocolError("INVALID_REQUEST", "join relation is not supported");
  return `SELECT l.reference_key AS left_reference_key,
         l.reference_key->>'id' AS left_reference_id,
         r.reference_key AS right_reference_key,
         r.reference_key->>'id' AS right_reference_id,
         ${relation === "dwithin" ? "ST_Distance(l.geography_wgs84, r.geography_wgs84, true)" : "NULL::double precision"} AS distance_m,
         NULL::integer AS rank
  FROM left_rows l
  JOIN gowm_spatial_v1.current_object r ON ${predicate}
  ${where(rightClauses)}
  ORDER BY l.reference_key->>'id', r.reference_key->>'id'
  LIMIT ${candidateLimit}`;
}

function aggregateQuery(input: Record<string, unknown>, limits: SpatialQueryLimits): BuiltSpatialQuery {
  const parameters = new Parameters();
  const areaLimit = parameters.add(Math.min(integer(input.areaLimit, 50), 100), "integer");
  const areaClauses: string[] = ["a.geometry_wgs84 IS NOT NULL"];
  if (Array.isArray(input.areaLayerKeys)) areaClauses.push(`a.layer_key = ANY(${parameters.add(input.areaLayerKeys, "text[]")})`);
  const objectClauses = objectTypeClause(input.objectTypes, "o", parameters);
  const relation = input.relation === "intersects"
    ? "ST_Intersects(a.geometry_wgs84, o.geometry_wgs84)"
    : "ST_Covers(a.geometry_wgs84, o.geometry_wgs84)";
  const matchClauses = [relation, "o.geometry_wgs84 IS NOT NULL", ...objectClauses];
  // A LEFT JOIN preserves areas with zero matching objects. The extra 101
  // slots cover the maximum 100 empty areas while still detecting one object
  // beyond the configured candidate budget.
  const candidateLimit = parameters.add(limits.maximumCandidates + 101, "integer");
  return {
    kind: "AGGREGATE",
    sort: "id",
    rowLimit: 100,
    values: parameters.values,
    text: `/* spatial.aggregate */
WITH areas AS MATERIALIZED (
  SELECT a.reference_key, a.geometry_wgs84
  FROM gowm_spatial_v1.layer_feature a
  ${where(areaClauses)}
  ORDER BY a.reference_key->>'id'
  LIMIT ${areaLimit}
), matches AS MATERIALIZED (
  SELECT a.reference_key AS area_reference_key,
         o.reference_key AS object_reference_key,
         o.object_type, o.subtype, o.status, o.source, o.properties,
         o.world_version, o.observed_at
  FROM areas a
  LEFT JOIN gowm_spatial_v1.current_object o ON ${matchClauses.join(" AND ")}
  ORDER BY a.reference_key->>'id', o.reference_key->>'id' NULLS FIRST
  LIMIT ${candidateLimit}
)
SELECT matches.*,
       (SELECT count(object_reference_key)::integer FROM matches) AS candidate_count
FROM matches
ORDER BY area_reference_key->>'id', object_reference_key->>'id' NULLS FIRST`
  };
}

function currentObjectColumns(alias: string, includeGeometryParameter: string): string {
  return `${alias}.reference_key,
         ${alias}.object_type,
         ${alias}.subtype,
         ${alias}.status,
         ${alias}.source,
         ${alias}.properties,
         ${alias}.observed_at,
         ${alias}.received_at,
         ${alias}.updated_at,
         ${alias}.world_version,
         ${alias}.confidence,
         ${alias}.freshness_ms,
         ${alias}.source_observation_id,
         ${alias}.provenance_summary,
         CASE WHEN ${includeGeometryParameter} THEN ST_AsGeoJSON(${alias}.geometry_wgs84)::jsonb ELSE NULL END AS geometry`;
}

function intersectionSourceColumns(alias: string): string {
  return `${alias}.data_scope_key,
         ${alias}.reference_key,
         ${alias}.object_type,
         ${alias}.subtype,
         ${alias}.geometry_wgs84,
         ${alias}.geography_wgs84,
         ${alias}.status,
         ${alias}.source,
         ${alias}.properties,
         ${alias}.observed_at,
         ${alias}.received_at,
         ${alias}.updated_at,
         ${alias}.world_version,
         ${alias}.confidence,
         ${alias}.freshness_ms,
         ${alias}.source_observation_id,
         ${alias}.provenance_summary`;
}

function layerColumns(alias: string, includeGeometryParameter: string): string {
  return `${alias}.reference_key,
         ${alias}.layer_key AS object_type,
         ${alias}.stable_name AS subtype,
         'ACTIVE'::text AS status,
         NULL::text AS source,
         ${alias}.properties,
         NULL::timestamptz AS observed_at,
         NULL::timestamptz AS received_at,
         ${alias}.updated_at,
         ${alias}.layer_version AS world_version,
         NULL::double precision AS confidence,
         GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - ${alias}.updated_at)) * 1000))::bigint AS freshness_ms,
         NULL::text AS source_observation_id,
         ${alias}.provenance_summary,
         CASE WHEN ${includeGeometryParameter} THEN ST_AsGeoJSON(${alias}.geometry_wgs84)::jsonb ELSE NULL END AS geometry`;
}

function commonObjectClauses(input: Record<string, unknown>, alias: string, parameters: Parameters): string[] {
  const clauses = objectTypeClause(input.objectTypes, alias, parameters);
  if (input.observedFrom !== undefined) clauses.push(`${alias}.observed_at >= ${parameters.add(input.observedFrom, "timestamptz")}`);
  if (input.observedTo !== undefined) clauses.push(`${alias}.observed_at < ${parameters.add(input.observedTo, "timestamptz")}`);
  return clauses;
}

function objectTypeClause(value: unknown, alias: string, parameters: Parameters): string[] {
  return Array.isArray(value) ? [`${alias}.object_type = ANY(${parameters.add(value, "text[]")})`] : [];
}

function addIdCursor(clauses: string[], cursor: SpatialCursorPayload | undefined, alias: string, parameters: Parameters): void {
  if (cursor) clauses.push(`${alias}.reference_key->>'id' > ${parameters.add(cursor.id, "text")}`);
}

function addCandidateReferenceClause(
  input: Record<string, unknown>,
  clauses: string[],
  alias: string,
  parameters: Parameters,
  maximumCandidates: number
): void {
  if (input.candidateReferences === undefined) return;
  if (!Array.isArray(input.candidateReferences) || input.candidateReferences.length === 0) {
    throw new ProviderProtocolError("INVALID_REQUEST", "candidateReferences must be a non-empty array");
  }
  if (input.candidateReferences.length > maximumCandidates) {
    throw new ProviderProtocolError("BUDGET_EXCEEDED", "spatial candidate reference budget exceeded", {
      retryable: false,
      details: { maximumCandidates }
    });
  }
  const references = input.candidateReferences.map(candidateReference);
  const parameter = parameters.add(JSON.stringify(references), "jsonb");
  clauses.push(`${alias}.reference_key IN (
    SELECT candidate.value
    FROM jsonb_array_elements(${parameter}) AS candidate(value)
  )`);
}

function candidateReference(value: unknown): Record<string, string> {
  const reference = asRecord(value);
  if (
    typeof reference.namespace !== "string" ||
    typeof reference.kind !== "string" ||
    typeof reference.id !== "string" ||
    typeof reference.version !== "string"
  ) {
    throw new ProviderProtocolError("INVALID_REQUEST", "candidateReferences must contain ReferenceKey values");
  }
  return {
    namespace: reference.namespace,
    kind: reference.kind,
    id: reference.id,
    version: reference.version
  };
}

function locationCoordinates(value: unknown): [unknown, unknown] {
  if (Array.isArray(value)) {
    if (value.length < 2 || value.length > 3) throw new ProviderProtocolError("INVALID_REQUEST", "location position is invalid");
    return [value[0], value[1]];
  }
  const location = asRecord(value);
  return [location.longitude, location.latitude];
}

function requestedLimit(input: Record<string, unknown>, maximumRows: number): number {
  return Math.min(integer(input.limit, 100), maximumRows, 1000);
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function summaryGroup(value: string): string {
  const fields: Record<string, string> = {
    objectType: "co.object_type",
    subtype: "co.subtype",
    status: "co.status",
    source: "co.source"
  };
  const expression = fields[value];
  if (!expression) throw new ProviderProtocolError("INVALID_REQUEST", "summary groupBy is not supported");
  return expression;
}

function assertTimeRange(input: Record<string, unknown>): void {
  if (typeof input.observedFrom === "string" && typeof input.observedTo === "string" && Date.parse(input.observedFrom) > Date.parse(input.observedTo)) {
    throw new ProviderProtocolError("INVALID_REQUEST", "observedFrom must not be later than observedTo");
  }
}

function where(clauses: readonly string[]): string {
  return clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderProtocolError("INVALID_REQUEST", "spatial input must be an object");
  }
  return value as Record<string, unknown>;
}
