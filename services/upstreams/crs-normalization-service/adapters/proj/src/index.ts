import { createRequire } from "node:module";
import type * as GdalModule from "gdal-async";
import {
  CrsError,
  TARGET_CRS,
  type CheckSourceCrsResponse,
  type Position,
  type TransformationProvenance
} from "@geospatial/crs-contract";

const require = createRequire(import.meta.url);
const gdalModuleSpecifier = process.env.CRS_GDAL_MODULE_PATH?.trim() || "gdal-async";
const gdal = require(gdalModuleSpecifier) as typeof GdalModule;

export const PROJ_VERSION = "9.5.1";
export const GDAL_ASYNC_VERSION = "3.12.3";

process.env.PROJ_NETWORK = "OFF";
process.env.PROJ_ONLY_BEST_DEFAULT = "YES";
gdal.config.set("PROJ_NETWORK", "OFF");
gdal.config.set("PROJ_ONLY_BEST_DEFAULT", "YES");

export interface PreparedTransformation {
  readonly sourceCrs: string;
  readonly sourceAlreadyWgs84: boolean;
  readonly provenance: TransformationProvenance;
  transform(position: ReadonlyArray<number>): Position;
}

export interface CoordinateEngine {
  prepare(sourceCrs: unknown): PreparedTransformation;
  checkSourceCrs(sourceCrs: unknown): CheckSourceCrsResponse;
  engineInfo(): {
    engine: "PROJ";
    engineVersion: string;
    integration: "gdal-async";
    integrationVersion: string;
    gdalVersion: string;
    networkEnabled: false;
    strictBestOperation: true;
  };
}

interface CachedTransformation {
  readonly sourceCrs: string;
  readonly source: GdalModule.SpatialReference;
  readonly target: GdalModule.SpatialReference;
  readonly transformation: GdalModule.CoordinateTransformation;
  readonly swapInputAxes: boolean;
  readonly swapOutputAxes: boolean;
}

export interface ProjAdapterOptions {
  maxCachedTransformations?: number;
}

export class ProjAdapter implements CoordinateEngine {
  private readonly cache = new Map<string, CachedTransformation>();
  private readonly maxCachedTransformations: number;

  constructor(options: ProjAdapterOptions = {}) {
    this.maxCachedTransformations = options.maxCachedTransformations ?? 128;
    if (!Number.isInteger(this.maxCachedTransformations) || this.maxCachedTransformations < 1) {
      throw new CrsError("INVALID_CRS", "maxCachedTransformations must be a positive integer.");
    }
  }

  engineInfo() {
    return {
      engine: "PROJ" as const,
      engineVersion: PROJ_VERSION,
      integration: "gdal-async" as const,
      integrationVersion: GDAL_ASYNC_VERSION,
      gdalVersion: gdal.version,
      networkEnabled: false as const,
      strictBestOperation: true as const
    };
  }

  checkSourceCrs(sourceCrs: unknown): CheckSourceCrsResponse {
    const canonical = canonicalizeSourceCrs(sourceCrs);
    const source = createSpatialReference(canonical);

    if (!source.isGeographic() && !source.isProjected()) {
      throw new CrsError(
        "TRANSFORMATION_UNAVAILABLE",
        `Source CRS ${canonical} is recognized but is not a supported two-dimensional geographic or projected CRS.`,
        { details: { sourceCrs: canonical } }
      );
    }

    const geographic = source.isGeographic();
    return {
      sourceCrs: canonical,
      recognized: true,
      kind: geographic ? "geographic" : "projected",
      traditionalGisInputOrder: geographic
        ? ["longitude", "latitude"]
        : ["easting", "northing"],
      normalizationTarget: TARGET_CRS,
      operationAvailability: "coordinate-and-grid-dependent"
    };
  }

  prepare(sourceCrs: unknown): PreparedTransformation {
    const canonical = canonicalizeSourceCrs(sourceCrs);
    const sourceAlreadyWgs84 = canonical === TARGET_CRS;
    let cacheHit = false;
    let context: CachedTransformation | undefined;

    if (!sourceAlreadyWgs84) {
      context = this.cache.get(canonical);
      if (context) {
        cacheHit = true;
        this.cache.delete(canonical);
        this.cache.set(canonical, context);
      } else {
        context = this.createTransformation(canonical);
        this.cache.set(canonical, context);
        this.evictOldestIfNeeded();
      }
    } else {
      this.checkSourceCrs(canonical);
    }

    const provenance: TransformationProvenance = {
      engine: "PROJ",
      engineVersion: PROJ_VERSION,
      integration: "gdal-async",
      integrationVersion: GDAL_ASYNC_VERSION,
      sourceCrs: canonical,
      targetCrs: TARGET_CRS,
      strictBestOperation: true,
      networkEnabled: false,
      cacheHit
    };

    return {
      sourceCrs: canonical,
      sourceAlreadyWgs84,
      provenance,
      transform: (position: ReadonlyArray<number>) => {
        if (sourceAlreadyWgs84) {
          return normalizeWgs84Position(position);
        }
        return this.transformPosition(context as CachedTransformation, position);
      }
    };
  }

  private createTransformation(sourceCrs: string): CachedTransformation {
    const source = createSpatialReference(sourceCrs);
    if (!source.isGeographic() && !source.isProjected()) {
      throw new CrsError(
        "TRANSFORMATION_UNAVAILABLE",
        `Source CRS ${sourceCrs} is not a supported two-dimensional geographic or projected CRS.`,
        { details: { sourceCrs } }
      );
    }

    const target = createSpatialReference(TARGET_CRS);
    try {
      return {
        sourceCrs,
        source,
        target,
        transformation: new gdal.CoordinateTransformation(source, target),
        swapInputAxes: source.EPSGTreatsAsLatLong() || source.EPSGTreatsAsNorthingEasting(),
        swapOutputAxes: target.EPSGTreatsAsLatLong() || target.EPSGTreatsAsNorthingEasting()
      };
    } catch (error) {
      throw mapTransformationError(error, sourceCrs);
    }
  }

  private transformPosition(
    context: CachedTransformation,
    position: ReadonlyArray<number>
  ): Position {
    let x = position[0] as number;
    let y = position[1] as number;
    if (context.swapInputAxes) {
      [x, y] = [y, x];
    }

    try {
      const transformed = context.transformation.transformPoint(x, y);
      let longitude = transformed.x;
      let latitude = transformed.y;
      if (context.swapOutputAxes) {
        [longitude, latitude] = [latitude, longitude];
      }
      const [normalizedLongitude, normalizedLatitude] = validateWgs84Output(
        longitude,
        latitude,
        context.sourceCrs
      );
      return [normalizedLongitude, normalizedLatitude, ...position.slice(2)];
    } catch (error) {
      if (error instanceof CrsError) {
        throw error;
      }
      throw mapTransformationError(error, context.sourceCrs);
    }
  }

  private evictOldestIfNeeded(): void {
    while (this.cache.size > this.maxCachedTransformations) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        return;
      }
      this.cache.delete(oldest);
    }
  }
}

export function canonicalizeSourceCrs(value: unknown): string {
  if (typeof value !== "string") {
    throw new CrsError("INVALID_CRS", "sourceCrs must be a string such as EPSG:3857.");
  }

  const trimmed = value.trim();
  if (/^WGS\s*84$/i.test(trimmed)) {
    return TARGET_CRS;
  }

  const match = /^EPSG\s*:\s*(\d{1,6})$/i.exec(trimmed);
  if (!match) {
    throw new CrsError(
      "INVALID_CRS",
      "P0 accepts only EPSG:<code> identifiers (plus the WGS84 alias). WKT, PROJJSON, and PROJ strings are not accepted.",
      { details: { received: trimmed.slice(0, 64) } }
    );
  }

  const code = Number(match[1]);
  if (!Number.isInteger(code) || code < 1 || code > 999999) {
    throw new CrsError("INVALID_CRS", "EPSG code must be an integer between 1 and 999999.");
  }
  return `EPSG:${code}`;
}

function createSpatialReference(canonical: string): GdalModule.SpatialReference {
  const code = Number(canonical.slice("EPSG:".length));
  try {
    return gdal.SpatialReference.fromEPSG(code);
  } catch (error) {
    throw new CrsError(
      "UNKNOWN_SOURCE_CRS",
      `Source CRS ${canonical} is not present in the deployed PROJ database.`,
      { details: { sourceCrs: canonical }, cause: error }
    );
  }
}

function normalizeWgs84Position(position: ReadonlyArray<number>): Position {
  const [longitude, latitude] = validateWgs84Output(
    position[0] as number,
    position[1] as number,
    TARGET_CRS
  );
  return [longitude, latitude, ...position.slice(2)];
}

function validateWgs84Output(
  longitude: number,
  latitude: number,
  sourceCrs: string
): [number, number] {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new CrsError(
      "TRANSFORMATION_FAILED",
      `Transformation from ${sourceCrs} produced a non-finite coordinate.`,
      { details: { sourceCrs } }
    );
  }

  const epsilon = 1e-10;
  if (longitude < -180 - epsilon || longitude > 180 + epsilon) {
    throw new CrsError(
      "COORDINATE_OUT_OF_RANGE",
      `Normalized longitude ${longitude} is outside [-180, 180].`,
      { details: { sourceCrs, longitude, latitude } }
    );
  }
  if (latitude < -90 - epsilon || latitude > 90 + epsilon) {
    throw new CrsError(
      "COORDINATE_OUT_OF_RANGE",
      `Normalized latitude ${latitude} is outside [-90, 90].`,
      { details: { sourceCrs, longitude, latitude } }
    );
  }

  return [
    Math.min(180, Math.max(-180, longitude)),
    Math.min(90, Math.max(-90, latitude))
  ];
}

function mapTransformationError(error: unknown, sourceCrs: string): CrsError {
  const message = error instanceof Error ? error.message : String(error);
  if (/No operation matching criteria|grid|resource file|missing/i.test(message)) {
    return new CrsError(
      "GRID_NOT_AVAILABLE",
      `The strict best transformation from ${sourceCrs} is unavailable with the installed offline grid resources.`,
      {
        details: {
          sourceCrs,
          targetCrs: TARGET_CRS,
          resourcePolicy: "offline-only, best-operation-required",
          engineMessage: message
        },
        cause: error
      }
    );
  }
  if (/Invalid coordinate|outside of projection domain|latitude or longitude exceeded/i.test(message)) {
    return new CrsError(
      "COORDINATE_OUT_OF_RANGE",
      `The coordinate is outside the valid transformation domain for ${sourceCrs}.`,
      { details: { sourceCrs, engineMessage: message }, cause: error }
    );
  }
  return new CrsError(
    "TRANSFORMATION_FAILED",
    `PROJ failed to transform a coordinate from ${sourceCrs} to ${TARGET_CRS}.`,
    { details: { sourceCrs, engineMessage: message }, cause: error }
  );
}
