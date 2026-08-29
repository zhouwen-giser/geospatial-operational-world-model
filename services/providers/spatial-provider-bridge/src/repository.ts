import type {
  DataSnapshotContext,
  EvidenceReference
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import { dataScopeDigest, decodeSpatialCursor, encodeSpatialCursor, type SpatialCursorPayload } from "./cursor.js";
import {
  CATALOG_FEATURE_EVIDENCE_SCHEMA_SHA256,
  CURRENT_OBJECT_EVIDENCE_SCHEMA_SHA256,
  LAYER_FEATURE_EVIDENCE_SCHEMA_SHA256,
  type SpatialOperationId
} from "./schemas.js";
import { buildSpatialQuery, type BuiltSpatialQuery, type SpatialQueryKind } from "./sql.js";
import type {
  DatasetSnapshotRow,
  ReferenceKey,
  SpatialMetric,
  SpatialObjectResult,
  SpatialQueryResult,
  SpatialRepositoryOptions,
  SpatialSqlClient
} from "./types.js";

const DATASET_SNAPSHOT_SQL = `/* gowm_spatial_v1 snapshot */
SELECT dataset_reference_key,
       current_world_version,
       catalog_snapshot_version,
       snapshot_consistency,
       transaction_timestamp() AS captured_at
FROM gowm_spatial_v1.dataset_descriptor
CROSS JOIN gowm_spatial_v1.catalog_snapshot
LIMIT 1`;

interface DatasetSnapshot {
  referenceKey: ReferenceKey;
  currentWorldVersion: string;
  capturedAt: string;
}

interface RepositoryLimits {
  maximumRows: number;
  maximumCandidates: number;
  maximumEvidenceReferences: number;
}

export class GowmSpatialV1Repository {
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly limits: RepositoryLimits;

  constructor(private readonly options: SpatialRepositoryOptions) {
    if (Buffer.byteLength(options.cursorSecret, "utf8") < 32) throw new Error("spatial cursor secret must contain at least 32 bytes");
    this.statementTimeoutMs = positiveInteger(options.statementTimeoutMs ?? 5_000, "statementTimeoutMs");
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? 1_000, "lockTimeoutMs");
    this.limits = {
      maximumRows: boundedPositiveInteger(options.maximumRows ?? 10_000, 10_000, "maximumRows"),
      maximumCandidates: boundedPositiveInteger(options.maximumCandidates ?? 50_000, 50_000, "maximumCandidates"),
      maximumEvidenceReferences: boundedPositiveInteger(options.maximumEvidenceReferences ?? 1_000, 1_000, "maximumEvidenceReferences")
    };
  }

  async execute(
    operationId: SpatialOperationId,
    input: unknown,
    dataScopeKey: string,
    deadlineRemainingMs: number,
    datasetScopeKey?: string
  ): Promise<SpatialQueryResult> {
    const client = await this.options.pool.connect().catch((error: unknown) => {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "spatial read pool is unavailable", {
        retryable: true,
        cause: error
      });
    });
    let transactionOpen = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionOpen = true;
      const statementTimeout = Math.max(1, Math.min(this.statementTimeoutMs, Math.floor(deadlineRemainingMs)));
      const lockTimeout = Math.max(1, Math.min(this.lockTimeoutMs, statementTimeout));
      await client.query("SELECT set_config('statement_timeout', $1::text, true)", [`${statementTimeout}ms`]);
      await client.query("SELECT set_config('lock_timeout', $1::text, true)", [`${lockTimeout}ms`]);
      await client.query("SELECT gowm_spatial_v1.set_data_scope($1::text)", [dataScopeKey]);
      await client.query("SELECT set_config('gowm.dataset_scope_key', $1::text, true)", [datasetScopeKey?.trim() ?? ""]);

      const snapshotResult = await client.query<DatasetSnapshotRow>(DATASET_SNAPSHOT_SQL);
      const snapshot = mapDatasetSnapshot(snapshotResult.rows[0]);
      const scopeDigest = dataScopeDigest(dataScopeKey, datasetScopeKey?.trim() || undefined);
      const record = asRecord(input);
      const sort = distanceOperation(operationId) ? "distance" : "id";
      const cursor = decodeSpatialCursor(
        typeof record.cursor === "string" ? record.cursor : undefined,
        { operationId, scopeDigest, snapshotVersion: snapshot.currentWorldVersion, sort },
        this.options.cursorSecret
      );
      const query = buildSpatialQuery(operationId, input, cursor, this.limits);
      const queryResult = await client.query(query.text, query.values);
      const mapped = this.mapResult(operationId, input, query, queryResult.rows, snapshot, scopeDigest);
      await client.query("COMMIT");
      transactionOpen = false;
      return mapped;
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async readiness(): Promise<{ ready: boolean; reasons: string[] }> {
    let client: SpatialSqlClient | undefined;
    try {
      client = await this.options.pool.connect();
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const version = await client.query<{ postgis_version: unknown }>("SELECT postgis_lib_version() AS postgis_version");
      if (this.options.postgisVersion !== undefined && version.rows[0]?.postgis_version !== this.options.postgisVersion) {
        throw new Error("PostGIS deployment attestation mismatch");
      }
      await client.query("SELECT * FROM gowm_spatial_v1.current_object LIMIT 0");
      await client.query("SELECT * FROM gowm_spatial_v1.current_geometry LIMIT 0");
      await client.query("SELECT * FROM gowm_spatial_v1.layer_feature LIMIT 0");
      await client.query("SELECT * FROM gowm_spatial_v1.catalog_feature LIMIT 0");
      await client.query("SELECT * FROM gowm_spatial_v1.catalog_feature_reference LIMIT 0");
      await client.query("SELECT * FROM gowm_spatial_v1.catalog_snapshot LIMIT 0");
      await client.query("SELECT * FROM gowm_spatial_v1.dataset_descriptor LIMIT 0");
      await client.query("ROLLBACK");
      return { ready: true, reasons: [] };
    } catch {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      return { ready: false, reasons: ["gowm_spatial_v1 read contract is unavailable"] };
    } finally {
      client?.release();
    }
  }

  private mapResult(
    operationId: SpatialOperationId,
    input: unknown,
    query: BuiltSpatialQuery,
    rows: Record<string, unknown>[],
    snapshot: DatasetSnapshot,
    scopeDigest: `sha256:${string}`
  ): SpatialQueryResult {
    const candidateCount = rows.length === 0 ? 0 : safeInteger(rows[0]?.candidate_count, "candidate_count");
    if (candidateCount > this.limits.maximumCandidates) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "spatial candidate budget exceeded", {
        retryable: false,
        details: { maximumCandidates: this.limits.maximumCandidates }
      });
    }
    const dataSnapshot = buildDataSnapshot(snapshot, scopeDigest);
    switch (query.kind) {
      case "OBJECT_PAGE": return this.objectPage(operationId, query, rows, candidateCount, snapshot, scopeDigest, dataSnapshot);
      case "COUNT": return this.countResult(rows[0], candidateCount, dataSnapshot);
      case "SUMMARY": return this.summaryResult(rows[0], candidateCount, dataSnapshot);
      case "JOIN": return this.joinResult(query, rows, candidateCount, dataSnapshot);
      case "AGGREGATE": return this.aggregateResult(input, rows, candidateCount, dataSnapshot);
    }
  }

  private objectPage(
    operationId: SpatialOperationId,
    query: BuiltSpatialQuery,
    rows: Record<string, unknown>[],
    candidateCount: number,
    snapshot: DatasetSnapshot,
    scopeDigest: `sha256:${string}`,
    dataSnapshot: DataSnapshotContext
  ): SpatialQueryResult {
    const truncated = rows.length > query.rowLimit;
    const visibleRows = rows.slice(0, query.rowLimit);
    const objects = visibleRows.map(mapObjectRow);
    const last = visibleRows.at(-1);
    const nextCursor = truncated && last
      ? encodeSpatialCursor({
          v: 1,
          operationId,
          scopeDigest,
          snapshotVersion: snapshot.currentWorldVersion,
          sort: query.sort,
          id: referenceKey(last.reference_key).id,
          ...(query.sort === "distance" ? { distanceM: finiteNumber(last.distance_m, "distance_m") } : {})
        }, this.options.cursorSecret)
      : undefined;
    const allEvidence = dedupeEvidence(visibleRows.map((row) => evidenceFromObjectRow(row, operationId)));
    const evidence = allEvidence.slice(0, this.limits.maximumEvidenceReferences);
    const evidenceTruncated = allEvidence.length > evidence.length;
    const context = queryContext(candidateCount, objects.length, evidenceTruncated, nextCursor, query.sort === "distance");
    return {
      output: {
        objects,
        page: {
          count: objects.length,
          truncated,
          ...(nextCursor === undefined ? {} : { nextCursor })
        },
        context
      },
      dataSnapshot,
      evidenceReferences: evidence,
      consumption: { rows: objects.length, candidates: candidateCount },
      warnings: evidenceTruncated ? ["spatial.evidenceTruncated=true"] : []
    };
  }

  private countResult(row: Record<string, unknown> | undefined, candidateCount: number, dataSnapshot: DataSnapshotContext): SpatialQueryResult {
    const count = safeInteger(row?.result_count ?? 0, "result_count");
    const sources = referenceKeyArray(row?.source_references);
    const evidenceRows = recordArray(row?.evidence_rows);
    const evidence = dedupeEvidence(evidenceRows.map(evidenceFromAggregateRow));
    const evidenceTruncated = count > evidence.length;
    return {
      output: {
        count,
        sourceReferences: sources,
        context: queryContext(candidateCount, 1, evidenceTruncated)
      },
      dataSnapshot,
      evidenceReferences: evidence,
      consumption: { rows: 1, candidates: candidateCount },
      warnings: evidenceTruncated ? ["spatial.evidenceTruncated=true"] : []
    };
  }

  private summaryResult(row: Record<string, unknown> | undefined, candidateCount: number, dataSnapshot: DataSnapshotContext): SpatialQueryResult {
    const total = safeInteger(row?.total ?? 0, "total");
    const groups = recordArray(row?.groups).map((group) => ({
      key: group.key === null || typeof group.key === "string" ? group.key : String(group.key),
      count: safeInteger(group.count, "group.count")
    }));
    const sources = referenceKeyArray(row?.source_references);
    const evidence = dedupeEvidence(recordArray(row?.evidence_rows).map(evidenceFromAggregateRow));
    const evidenceTruncated = total > evidence.length;
    return {
      output: {
        total,
        groups,
        sourceReferences: sources,
        context: queryContext(candidateCount, groups.length, evidenceTruncated)
      },
      dataSnapshot,
      evidenceReferences: evidence,
      consumption: { rows: groups.length, candidates: candidateCount },
      warnings: evidenceTruncated ? ["spatial.evidenceTruncated=true"] : []
    };
  }

  private joinResult(query: BuiltSpatialQuery, rows: Record<string, unknown>[], candidateCount: number, dataSnapshot: DataSnapshotContext): SpatialQueryResult {
    const truncated = rows.length > query.rowLimit;
    const visible = rows.slice(0, query.rowLimit);
    const pairs = visible.map((row) => ({
      leftReferenceKey: referenceKey(row.left_reference_key),
      rightReferenceKey: referenceKey(row.right_reference_key),
      ...(row.distance_m === null || row.distance_m === undefined ? {} : { distanceM: finiteNumber(row.distance_m, "distance_m") }),
      ...(row.rank === null || row.rank === undefined ? {} : { rank: safeInteger(row.rank, "rank") })
    }));
    const allEvidence = dedupeEvidence(visible.flatMap((row) => [
      evidenceForReference(referenceKey(row.left_reference_key)),
      evidenceForReference(referenceKey(row.right_reference_key))
    ]));
    const evidence = allEvidence.slice(0, this.limits.maximumEvidenceReferences);
    const evidenceTruncated = allEvidence.length > evidence.length;
    return {
      output: {
        pairs,
        page: { count: pairs.length, truncated },
        context: queryContext(candidateCount, pairs.length, evidenceTruncated)
      },
      dataSnapshot,
      evidenceReferences: evidence,
      consumption: { rows: pairs.length, candidates: candidateCount },
      warnings: ["spatial.experimental=true", ...(evidenceTruncated ? ["spatial.evidenceTruncated=true"] : [])]
    };
  }

  private aggregateResult(input: unknown, rows: Record<string, unknown>[], candidateCount: number, dataSnapshot: DataSnapshotContext): SpatialQueryResult {
    const record = asRecord(input);
    const metrics = metricArray(record.metrics);
    assertMetrics(metrics);
    const grouped = new Map<string, { referenceKey: ReferenceKey; rows: Record<string, unknown>[] }>();
    for (const row of rows) {
      const areaReferenceKey = referenceKey(row.area_reference_key);
      const key = `${areaReferenceKey.namespace}/${areaReferenceKey.kind}/${areaReferenceKey.id}/${areaReferenceKey.version}`;
      const current = grouped.get(key) ?? { referenceKey: areaReferenceKey, rows: [] };
      current.rows.push(row);
      grouped.set(key, current);
    }
    const areas = [...grouped.values()].map((area) => ({
      areaReferenceKey: area.referenceKey,
      metrics: Object.fromEntries(metrics.map((metric) => [
        metric.name,
        calculateMetric(metric, area.rows.filter((row) => isRecord(row.object_reference_key)))
      ]))
    }));
    const allEvidence = dedupeEvidence(rows.flatMap((row) => {
      const values = [evidenceForReference(referenceKey(row.area_reference_key))];
      if (isRecord(row.object_reference_key)) {
        values.push(evidenceForReference(referenceKey(row.object_reference_key), {
          worldVersion: safeInteger(row.world_version, "world_version"),
          observedAt: optionalDate(row.observed_at)
        }));
      }
      return values;
    }));
    const evidence = allEvidence.slice(0, this.limits.maximumEvidenceReferences);
    const evidenceTruncated = allEvidence.length > evidence.length;
    return {
      output: {
        areas,
        context: queryContext(candidateCount, areas.length, evidenceTruncated)
      },
      dataSnapshot,
      evidenceReferences: evidence,
      consumption: { rows: areas.length, candidates: candidateCount },
      warnings: ["spatial.experimental=true", ...(evidenceTruncated ? ["spatial.evidenceTruncated=true"] : [])]
    };
  }
}

function mapDatasetSnapshot(row: DatasetSnapshotRow | undefined): DatasetSnapshot {
  if (!row) throw new ProviderProtocolError("SCOPE_DENIED", "spatial data scope is unavailable", { retryable: false });
  if (row.snapshot_consistency !== "CONSISTENT_AT_START") {
    throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "gowm_spatial_v1 returned a dishonest snapshot consistency");
  }
  const reference = referenceKey(row.dataset_reference_key);
  if (reference.kind !== "DATASET" || reference.version !== String(row.current_world_version)) {
    throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "dataset descriptor reference is inconsistent");
  }
  const catalogSnapshotVersion = requiredString(row.catalog_snapshot_version, "catalog_snapshot_version");
  return {
    referenceKey: reference,
    currentWorldVersion: `${String(row.current_world_version)}:${catalogSnapshotVersion}`,
    capturedAt: requiredDate(row.captured_at, "captured_at")
  };
}

function buildDataSnapshot(snapshot: DatasetSnapshot, scopeDigest: `sha256:${string}`): DataSnapshotContext {
  return {
    consistency: "CONSISTENT_AT_START",
    capturedAt: snapshot.capturedAt,
    scopeDigest,
    resources: [{
      referenceKey: snapshot.referenceKey,
      authority: "GOWM Foundation",
      pinning: "AT_LEAST",
      digest: sha256({
        contract: "gowm_spatial_v1",
        referenceKey: snapshot.referenceKey,
        snapshotVersion: snapshot.currentWorldVersion,
        consistency: "CONSISTENT_AT_START"
      })
    }]
  };
}

function mapObjectRow(row: Record<string, unknown>): SpatialObjectResult {
  const value: SpatialObjectResult = {
    referenceKey: referenceKey(row.reference_key),
    objectType: requiredString(row.object_type, "object_type"),
    subtype: nullableString(row.subtype, "subtype"),
    status: requiredString(row.status, "status"),
    source: nullableString(row.source, "source"),
    properties: isRecord(row.properties) ? row.properties : {},
    observedAt: optionalDate(row.observed_at),
    receivedAt: optionalDate(row.received_at),
    updatedAt: requiredDate(row.updated_at, "updated_at"),
    worldVersion: safeInteger(row.world_version, "world_version"),
    confidence: row.confidence === null || row.confidence === undefined ? null : finiteNumber(row.confidence, "confidence"),
    freshnessMs: row.freshness_ms === null || row.freshness_ms === undefined ? null : safeInteger(row.freshness_ms, "freshness_ms"),
    provenance: {
      authority: "GOWM Foundation",
      sourceObservationId: nullableString(row.source_observation_id, "source_observation_id"),
      summary: isRecord(row.provenance_summary) ? row.provenance_summary : {}
    }
  };
  if (row.distance_m !== null && row.distance_m !== undefined) value.distanceM = finiteNumber(row.distance_m, "distance_m");
  if (isRecord(row.geometry)) value.geometry = row.geometry as NonNullable<SpatialObjectResult["geometry"]>;
  return value;
}

function evidenceFromObjectRow(row: Record<string, unknown>, operationId: SpatialOperationId): EvidenceReference {
  return evidenceForReference(referenceKey(row.reference_key), {
    worldVersion: safeInteger(row.world_version, "world_version"),
    observedAt: optionalDate(row.observed_at)
  }, operationId === "spatial.find-intersections");
}

function evidenceFromAggregateRow(row: Record<string, unknown>): EvidenceReference {
  return evidenceForReference(referenceKey(row.referenceKey), {
    worldVersion: safeInteger(row.worldVersion, "worldVersion"),
    observedAt: optionalDate(row.observedAt)
  });
}

function evidenceForReference(
  key: ReferenceKey,
  metadata: { worldVersion?: number; observedAt?: string | null } = {},
  catalogFeature = false
): EvidenceReference {
  const layer = key.kind === "LAYER_FEATURE";
  return {
    evidenceId: key.id,
    authority: "GOWM Foundation",
    evidenceType: layer ? "LAYER_VERSION" : "CURRENT_PROJECTION_SOURCE",
    referenceKey: key,
    schemaUri: layer
      ? catalogFeature
        ? "urn:gowm:foundation:gowm_spatial_v1:catalog_feature_reference:1"
        : "urn:gowm:foundation:gowm_spatial_v1:layer_feature:1"
      : "urn:gowm:foundation:gowm_spatial_v1:current_object:1",
    schemaHash: layer
      ? catalogFeature ? CATALOG_FEATURE_EVIDENCE_SCHEMA_SHA256 : LAYER_FEATURE_EVIDENCE_SCHEMA_SHA256
      : CURRENT_OBJECT_EVIDENCE_SCHEMA_SHA256,
    ...(metadata.observedAt ? { observedAt: metadata.observedAt } : {}),
    ...(metadata.worldVersion === undefined ? {} : { worldVersion: metadata.worldVersion })
  };
}

function dedupeEvidence(values: EvidenceReference[]): EvidenceReference[] {
  const unique = new Map<string, EvidenceReference>();
  for (const value of values) unique.set(`${value.evidenceType}/${value.referenceKey.id}/${value.referenceKey.version}`, value);
  return [...unique.values()];
}

function queryContext(
  candidateCount: number,
  rowCount: number,
  evidenceTruncated: boolean,
  nextCursor?: string,
  distance = false
): Record<string, unknown> {
  return {
    crs: "EPSG:4326",
    snapshotConsistency: "CONSISTENT_AT_START",
    candidateCount,
    rowCount,
    evidenceTruncated,
    ...(distance ? { distanceUnit: "meter" } : {}),
    ...(nextCursor === undefined ? {} : { nextCursor })
  };
}

function metricArray(value: unknown): SpatialMetric[] {
  return Array.isArray(value) ? value as SpatialMetric[] : [];
}

function assertMetrics(metrics: SpatialMetric[]): void {
  const names = new Set<string>();
  for (const metric of metrics) {
    if (names.has(metric.name)) throw new ProviderProtocolError("INVALID_REQUEST", "aggregate metric names must be unique");
    names.add(metric.name);
    if (metric.op !== "count" && metric.field === undefined) {
      throw new ProviderProtocolError("INVALID_REQUEST", `aggregate metric ${metric.name} requires field`);
    }
    if (["sum", "avg", "min", "max"].includes(metric.op) && metric.field !== "properties.battery") {
      throw new ProviderProtocolError("INVALID_REQUEST", `aggregate metric ${metric.name} requires numeric properties.battery`);
    }
  }
}

function calculateMetric(metric: SpatialMetric, rows: Record<string, unknown>[]): number | null {
  if (metric.op === "count") return rows.length;
  const values = rows.map((row) => metricValue(metric.field, row)).filter((value) => value !== null);
  if (metric.op === "distinct_count") return new Set(values.map((value) => JSON.stringify(value))).size;
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numbers.length === 0) return null;
  switch (metric.op) {
    case "sum": return numbers.reduce((sum, value) => sum + value, 0);
    case "avg": return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    case "min": return Math.min(...numbers);
    case "max": return Math.max(...numbers);
    default: return null;
  }
}

function metricValue(field: SpatialMetric["field"], row: Record<string, unknown>): unknown {
  switch (field) {
    case "objectType": return row.object_type ?? null;
    case "subtype": return row.subtype ?? null;
    case "status": return row.status ?? null;
    case "source": return row.source ?? null;
    case "properties.battery": {
      const properties = isRecord(row.properties) ? row.properties : {};
      const value = properties.battery;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    default: return null;
  }
}

function mapDatabaseError(error: unknown): ProviderProtocolError {
  if (error instanceof ProviderProtocolError) return error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code === "42501") return new ProviderProtocolError("SCOPE_DENIED", "spatial data scope is unavailable", { retryable: false });
  if (code === "57014") return new ProviderProtocolError("DEADLINE_EXCEEDED", "spatial statement deadline exceeded", { cause: error });
  if (["55P03", "53300", "53400"].includes(code ?? "")) {
    return new ProviderProtocolError("OVERLOADED", "spatial read pool is overloaded", { cause: error });
  }
  return new ProviderProtocolError("PROVIDER_NOT_READY", "spatial read contract execution failed", {
    retryable: true,
    cause: error
  });
}

function distanceOperation(operationId: SpatialOperationId): boolean {
  return operationId === "spatial.find-nearby" || operationId === "spatial.find-nearest" || operationId === "spatial.find-near-route";
}

function referenceKey(value: unknown): ReferenceKey {
  if (!isRecord(value) || typeof value.namespace !== "string" || typeof value.kind !== "string" || typeof value.id !== "string" || typeof value.version !== "string") {
    throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "gowm_spatial_v1 returned an invalid opaque reference key");
  }
  return { namespace: value.namespace, kind: value.kind, id: value.id, version: value.version };
}

function referenceKeyArray(value: unknown): ReferenceKey[] {
  return Array.isArray(value) ? value.map(referenceKey) : [];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} is invalid`);
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} is invalid`);
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} is invalid`);
  return number;
}

function safeInteger(value: unknown, name: string): number {
  const number = finiteNumber(value, name);
  if (!Number.isSafeInteger(number) || number < 0) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} is invalid`);
  return number;
}

function requiredDate(value: unknown, name: string): string {
  const result = optionalDate(value);
  if (!result) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} is invalid`);
  return result;
}

function optionalDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "spatial timestamp is invalid");
  return date.toISOString();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boundedPositiveInteger(value: number, maximum: number, name: string): number {
  const parsed = positiveInteger(value, name);
  if (parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProviderProtocolError("INVALID_REQUEST", "spatial input must be an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
