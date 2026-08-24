import {
  FoundationPortError,
  FoundationReceiptFactory,
  asFoundationEngineError,
  type FoundationExecution,
  type H3Cell,
  type H3GeoPoint,
  type H3IndexPointsInput,
  type H3LocalAdapter,
  type H3ProjectionInput,
  type H3ProjectionResult,
  type H3ResolutionInput,
  type LocalSqlExecutor
} from "../../../platform/foundation-ports/src/index.js";
import {
  FOUNDATION_OPERATION_SCHEMAS,
  assertOperationInput,
  assertOperationOutput
} from "./contract-attestations.js";

const H3_RESOLUTION_POLICY = Object.freeze({
  GLOBAL: 2,
  REGIONAL: 4,
  CITY: 7,
  DISTRICT: 8,
  STREET: 10,
  FINE: 12
} as const);

const DEFAULT_PROJECTION_RESOLUTIONS = Object.freeze([7, 8, 9, 10]);
const H3_CELL_PATTERN = /^[0-9a-f]{15}$/;

export const H3_PG_INDEX_POINTS_SQL = `WITH indexed AS (
  SELECT (input.ordinality - 1)::integer AS ordinal,
         h3_latlng_to_cell(
           ST_SetSRID(ST_MakePoint(input.longitude, input.latitude), 4326),
           $3::integer
         ) AS index
  FROM unnest($1::double precision[], $2::double precision[])
       WITH ORDINALITY AS input(longitude, latitude, ordinality)
)
SELECT ordinal, index::text AS index,
       h3_get_resolution(index)::integer AS engine_resolution
FROM indexed
ORDER BY ordinal`;

export const H3_PG_PROJECT_POINT_SQL = `WITH requested AS (
  SELECT input.resolution::integer AS resolution,
         (input.ordinality - 1)::integer AS ordinal
  FROM unnest($3::integer[]) WITH ORDINALITY AS input(resolution, ordinality)
), indexed AS (
  SELECT requested.ordinal, requested.resolution,
         h3_latlng_to_cell(
           ST_SetSRID(ST_MakePoint($1::double precision, $2::double precision), 4326),
           requested.resolution
         ) AS index
  FROM requested
)
SELECT ordinal, resolution, index::text AS index,
       h3_get_resolution(index)::integer AS engine_resolution
FROM indexed
ORDER BY ordinal`;

interface H3PgRow {
  ordinal: number | string;
  index: string;
  engine_resolution: number | string;
  resolution?: number | string;
}

export interface H3PgLocalAdapterOptions {
  h3PgVersion: string;
  policyVersion?: string;
  maximumBatchItems?: number;
  engineDigest?: `sha256:${string}`;
  receipts?: FoundationReceiptFactory;
}

export class H3PgLocalAdapter implements H3LocalAdapter {
  private readonly policyVersion: string;
  private readonly maximumBatchItems: number;
  private readonly receipts: FoundationReceiptFactory;

  constructor(
    private readonly sql: LocalSqlExecutor,
    private readonly options: H3PgLocalAdapterOptions
  ) {
    if (options.h3PgVersion.trim().length === 0) {
      throw new FoundationPortError("FOUNDATION_INVALID_INPUT", "h3-pg version attestation is required", {
        stage: "REQUEST_VALIDATION",
        retryable: false
      });
    }
    this.policyVersion = options.policyVersion ?? "gowm.h3-local-projection/1.0";
    this.maximumBatchItems = options.maximumBatchItems ?? 100_000;
    this.receipts = options.receipts ?? new FoundationReceiptFactory();
  }

  async indexPoints(input: H3IndexPointsInput): Promise<FoundationExecution<H3Cell[]>> {
    const startedAt = this.receipts.start();
    if (input.points.length === 0 || input.points.length > this.maximumBatchItems) {
      throw new FoundationPortError(
        "FOUNDATION_INVALID_INPUT",
        `H3 point batch must contain 1 through ${this.maximumBatchItems} items`,
        {
          stage: "REQUEST_VALIDATION",
          retryable: false,
          details: { count: input.points.length, maximumBatchItems: this.maximumBatchItems }
        }
      );
    }
    input.points.forEach(assertPoint);
    const resolution = resolveResolution(input.resolution);
    assertOperationInput("h3.index.points", input);
    const rows = await this.run<H3PgRow>(
      "h3.index.points",
      H3_PG_INDEX_POINTS_SQL,
      [
        input.points.map((point) => point.longitude),
        input.points.map((point) => point.latitude),
        resolution
      ]
    );
    const ordered = validateRows(rows, input.points.length, resolution);
    const result = ordered.map((row) => ({ index: row.index, resolution }));
    assertOperationOutput("h3.index.points", result);
    return this.receipts.complete({
      startedAt,
      operationId: "h3.index.points",
      operationVersion: "1.0",
      schemas: FOUNDATION_OPERATION_SCHEMAS.h3IndexPoints,
      engine: this.engineAttestation(),
      method: {
        methodId: "h3_latlng_to_cell",
        methodVersion: "1.0.0"
      },
      policyVersion: this.policyVersion,
      policy: this.policySnapshot(),
      input,
      result,
      changes: { repairApplied: false, typeChanged: false },
      artifacts: this.databaseArtifacts()
    });
  }

  async projectPoint(input: H3ProjectionInput): Promise<FoundationExecution<H3ProjectionResult>> {
    const startedAt = this.receipts.start();
    assertPoint(input.point);
    const resolutions = input.resolutions === undefined
      ? [...DEFAULT_PROJECTION_RESOLUTIONS]
      : validateProjectionResolutions(input.resolutions);
    const normalizedInput = { point: input.point, resolutions };
    assertOperationInput("gowm.foundation.h3.project-point", normalizedInput);
    const rows = await this.run<H3PgRow>(
      "gowm.foundation.h3.project-point",
      H3_PG_PROJECT_POINT_SQL,
      [input.point.longitude, input.point.latitude, resolutions]
    );
    if (rows.length !== resolutions.length) invalidEngineResult("H3 projection row count did not match requested resolutions", {
      expectedRows: resolutions.length,
      actualRows: rows.length
    });

    const byOrdinal = new Map<number, H3PgRow>();
    for (const row of rows) {
      const ordinal = integer(row.ordinal);
      if (ordinal < 0 || ordinal >= resolutions.length || byOrdinal.has(ordinal)) {
        invalidEngineResult("H3 projection returned an invalid ordinal", { ordinal });
      }
      const requestedResolution = resolutions[ordinal];
      if (requestedResolution === undefined) invalidEngineResult("H3 projection ordinal was out of range", { ordinal });
      validateCellRow(row, requestedResolution);
      byOrdinal.set(ordinal, row);
    }

    const cells: Record<string, string> = {};
    resolutions.forEach((resolution, ordinal) => {
      const row = byOrdinal.get(ordinal);
      if (row === undefined) invalidEngineResult("H3 projection result was incomplete", { ordinal, resolution });
      cells[String(resolution)] = row.index;
    });
    const result: H3ProjectionResult = {
      cells,
      candidateOnly: true,
      exactSpatialAuthority: "POSTGIS"
    };
    assertOperationOutput("gowm.foundation.h3.project-point", result);
    return this.receipts.complete({
      startedAt,
      operationId: "gowm.foundation.h3.project-point",
      operationVersion: "1.0",
      schemas: FOUNDATION_OPERATION_SCHEMAS.h3ProjectPoint,
      engine: this.engineAttestation(),
      method: {
        methodId: "h3_latlng_to_cell",
        methodVersion: "1.0.0"
      },
      policyVersion: this.policyVersion,
      policy: this.policySnapshot(),
      input: normalizedInput,
      result,
      changes: { repairApplied: false, typeChanged: false },
      artifacts: this.databaseArtifacts()
    });
  }

  private async run<Row>(operationId: string, text: string, values: readonly unknown[]): Promise<Row[]> {
    try {
      return (await this.sql.query<Row>(text, values)).rows;
    } catch (error) {
      throw asFoundationEngineError(error, operationId);
    }
  }

  private engineAttestation(): { name: string; version: string; digest?: `sha256:${string}` } {
    return {
      name: "h3-pg",
      version: this.options.h3PgVersion,
      ...(this.options.engineDigest === undefined ? {} : { digest: this.options.engineDigest })
    };
  }

  private policySnapshot(): Record<string, unknown> {
    return {
      resolutionPolicy: H3_RESOLUTION_POLICY,
      maximumBatchItems: this.maximumBatchItems,
      candidateOnly: true,
      exactSpatialAuthority: "POSTGIS",
      remoteFallback: "DENY"
    };
  }

  private databaseArtifacts(): Array<{
    kind: "DATABASE";
    name: string;
    version: string;
    digest?: `sha256:${string}`;
  }> {
    return [
      {
        kind: "DATABASE",
        name: "h3-pg",
        version: this.options.h3PgVersion,
        ...(this.options.engineDigest === undefined ? {} : { digest: this.options.engineDigest })
      }
    ];
  }
}

function resolveResolution(input: H3ResolutionInput): number {
  const resolution = typeof input === "string" ? H3_RESOLUTION_POLICY[input] : input;
  if (!Number.isInteger(resolution) || resolution < 0 || resolution > 15) {
    throw new FoundationPortError(
      "FOUNDATION_H3_INVALID_RESOLUTION",
      "H3 resolution must be an integer from 0 through 15 or a supported policy name",
      {
        stage: "REQUEST_VALIDATION",
        retryable: false,
        details: { input }
      }
    );
  }
  return resolution;
}

function assertPoint(point: H3GeoPoint, index?: number): void {
  if (!Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180) {
    throw new FoundationPortError("FOUNDATION_H3_INVALID_COORDINATE", "longitude must be within [-180, 180]", {
      stage: "REQUEST_VALIDATION",
      retryable: false,
      details: { ...(index === undefined ? {} : { index }), point }
    });
  }
  if (!Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90) {
    throw new FoundationPortError("FOUNDATION_H3_INVALID_COORDINATE", "latitude must be within [-90, 90]", {
      stage: "REQUEST_VALIDATION",
      retryable: false,
      details: { ...(index === undefined ? {} : { index }), point }
    });
  }
}

function validateProjectionResolutions(input: number[]): number[] {
  if (input.length === 0 || input.length > 16) {
    throw new FoundationPortError("FOUNDATION_H3_INVALID_RESOLUTION", "Projection resolutions must contain 1 through 16 items", {
      stage: "REQUEST_VALIDATION",
      retryable: false,
      details: { count: input.length }
    });
  }
  const resolutions = input.map(resolveResolution);
  if (new Set(resolutions).size !== resolutions.length) {
    throw new FoundationPortError("FOUNDATION_H3_INVALID_RESOLUTION", "Projection resolutions must be unique", {
      stage: "REQUEST_VALIDATION",
      retryable: false,
      details: { resolutions }
    });
  }
  return resolutions;
}

function validateRows(rows: H3PgRow[], expectedCount: number, resolution: number): H3PgRow[] {
  if (rows.length !== expectedCount) invalidEngineResult("H3 row count did not match point count", {
    expectedRows: expectedCount,
    actualRows: rows.length
  });
  const byOrdinal = new Map<number, H3PgRow>();
  for (const row of rows) {
    const ordinal = integer(row.ordinal);
    if (ordinal < 0 || ordinal >= expectedCount || byOrdinal.has(ordinal)) {
      invalidEngineResult("H3 engine returned an invalid ordinal", { ordinal });
    }
    validateCellRow(row, resolution);
    byOrdinal.set(ordinal, row);
  }
  return Array.from({ length: expectedCount }, (_, ordinal) => {
    const row = byOrdinal.get(ordinal);
    if (row === undefined) invalidEngineResult("H3 engine result was incomplete", { ordinal });
    return row;
  });
}

function validateCellRow(row: H3PgRow, resolution: number): void {
  if (!H3_CELL_PATTERN.test(row.index)) {
    invalidEngineResult("h3-pg returned an invalid cell index", { index: row.index });
  }
  const engineResolution = integer(row.engine_resolution);
  if (engineResolution !== resolution) {
    invalidEngineResult("h3-pg cell resolution did not match the request", {
      expectedResolution: resolution,
      engineResolution,
      index: row.index
    });
  }
  if (row.resolution !== undefined && integer(row.resolution) !== resolution) {
    invalidEngineResult("h3-pg projection echoed an unexpected resolution", {
      expectedResolution: resolution,
      resolution: row.resolution
    });
  }
}

function integer(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) invalidEngineResult("h3-pg returned a non-integer value", { value });
  return parsed;
}

function invalidEngineResult(message: string, details: Record<string, unknown>): never {
  throw new FoundationPortError("FOUNDATION_INVALID_ENGINE_RESULT", message, {
    stage: "RESULT_ASSEMBLY",
    retryable: false,
    details: { ...details, fallbackApplied: false }
  });
}
