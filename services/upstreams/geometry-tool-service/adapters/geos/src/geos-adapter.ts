import initGeosJs from "geos-wasm";
import {
  GeometryServiceError,
  asGeometryServiceError,
  unwrapGeometry,
  type AdapterExecution,
  type Geometry,
  type GeometryEngineAdapter,
  type GeometryEnvelope,
  type GeometryOperation,
  type OperationRequest,
  type ValidationDetail,
} from "@geospatial/geometry-contract";

type Geos = Awaited<ReturnType<typeof initGeosJs>>;
type GeometryPointer = number;

const CAP_STYLE = { round: 1, flat: 2, square: 3 } as const;
const JOIN_STYLE = { round: 1, mitre: 2, bevel: 3 } as const;
const PREDICATES = {
  equals: "GEOSEquals_r",
  disjoint: "GEOSDisjoint_r",
  intersects: "GEOSIntersects_r",
  touches: "GEOSTouches_r",
  crosses: "GEOSCrosses_r",
  within: "GEOSWithin_r",
  contains: "GEOSContains_r",
  overlaps: "GEOSOverlaps_r",
  covers: "GEOSCovers_r",
  covered_by: "GEOSCoveredBy_r",
} as const;

export class GeosWasmAdapter implements GeometryEngineAdapter {
  readonly name = "GEOS-WASM";
  version = "uninitialized";
  private geos: Geos | undefined;
  private context = 0;
  private initializing: Promise<void> | undefined;

  async initialize(): Promise<void> {
    if (this.geos) return;
    this.initializing ??= (async () => {
      const geos = await initGeosJs();
      const context = geos.GEOS_init_r();
      if (!context) throw new Error("GEOS_init_r failed");
      this.geos = geos;
      this.context = context;
      this.version = geos.GEOSversion();
    })();
    await this.initializing;
  }

  async close(): Promise<void> {
    if (this.geos && this.context) this.geos.GEOS_finish_r(this.context);
    this.geos = undefined;
    this.context = 0;
    this.initializing = undefined;
    this.version = "closed";
  }

  async execute(request: OperationRequest): Promise<AdapterExecution> {
    await this.initialize();
    const operation = request.operation;
    try {
      if (operation === "parse_geojson") return this.parseGeoJsonRequest(request);
      if (operation === "parse_wkt") return this.parseWktRequest(request);
      if (operation === "parse_wkb") return this.parseWkbRequest(request);
      if (operation === "collect") return this.collect(request);

      const input = this.requireInput(request.input, operation);
      const geometry = this.readEnvelope(input);
      let other: GeometryPointer | undefined;
      try {
        if (request.other) other = this.readEnvelope(request.other);
        switch (operation) {
          case "to_geojson":
            return { geometry: this.writeGeoJSON(geometry) };
          case "to_wkt":
            return { scalar: this.writeWKT(geometry) };
          case "to_wkb":
            return { scalar: this.writeWKBHex(geometry, input.srid !== undefined) };
          case "validate": {
            const detail = this.validationDetail(geometry);
            return { scalar: detail.valid, detail };
          }
          case "make_valid":
            return this.geometryResult(this.callUnary("GEOSMakeValid_r", geometry));
          case "remove_repeated_points":
            return this.geometryResult(this.callUnaryNumber("GEOSRemoveRepeatedPoints_r", geometry, this.numberParam(request, "tolerance", 0)));
          case "normalize": {
            const clone = this.clone(geometry);
            const status = this.api.GEOSNormalize_r(this.context, clone);
            if (status < 0) {
              this.destroy(clone);
              throw new Error("GEOSNormalize failed");
            }
            return this.geometryResult(clone);
          }
          case "orient_polygon": {
            const clone = this.clone(geometry);
            const clockwise = this.booleanParam(request, "exteriorClockwise", false) ? 1 : 0;
            const status = this.api.GEOSOrientPolygons_r(this.context, clone, clockwise);
            if (status === 0) {
              this.destroy(clone);
              throw new Error("GEOSOrientPolygons failed");
            }
            return this.geometryResult(clone);
          }
          case "force_2d":
            return { geometry: this.writeGeoJSON(geometry, 2) };
          case "buffer":
            return this.buffer(geometry, request);
          case "intersection":
          case "union":
          case "difference":
          case "symmetric_difference":
            return this.overlay(operation, geometry, this.requireOther(other, operation), request);
          case "unary_union":
            return this.geometryResult(this.callUnary("GEOSUnaryUnion_r", geometry));
          case "coverage_union":
            return this.geometryResult(this.callUnary("GEOSCoverageUnion_r", geometry));
          case "equals":
          case "disjoint":
          case "intersects":
          case "touches":
          case "crosses":
          case "within":
          case "contains":
          case "overlaps":
          case "covers":
          case "covered_by":
            return { scalar: this.predicate(operation, geometry, this.requireOther(other, operation)) };
          case "relate":
            return { scalar: this.relate(geometry, this.requireOther(other, operation), request) };
          case "area":
          case "length":
          case "minimum_clearance":
            return { scalar: this.measureUnary(operation, geometry) };
          case "distance":
          case "hausdorff_distance":
            return { scalar: this.measureBinary(operation, geometry, this.requireOther(other, operation)) };
          case "simplify":
            return this.geometryResult(this.callUnaryNumber("GEOSSimplify_r", geometry, this.requiredNumberParam(request, "tolerance")));
          case "simplify_preserve_topology":
            return this.geometryResult(this.callUnaryNumber("GEOSTopologyPreserveSimplify_r", geometry, this.requiredNumberParam(request, "tolerance")));
          case "coverage_simplify": {
            const tolerance = this.requiredNumberParam(request, "tolerance");
            const preserveBoundary = this.booleanParam(request, "preserveBoundary", true) ? 1 : 0;
            const result = this.api.GEOSCoverageSimplifyVW_r(this.context, geometry, tolerance, preserveBoundary);
            return this.geometryResult(this.ensureGeometry(result, operation));
          }
          case "snap": {
            const result = this.api.GEOSSnap_r(this.context, geometry, this.requireOther(other, operation), this.requiredNumberParam(request, "tolerance"));
            return this.geometryResult(this.ensureGeometry(result, operation));
          }
          case "reduce_precision": {
            const gridSize = request.options?.precision?.gridSize ?? this.requiredNumberParam(request, "gridSize");
            const flags = request.options?.precision?.keepCollapsed ? 2 : 0;
            const result = this.api.GEOSGeom_setPrecision_r(this.context, geometry, gridSize, flags);
            return this.geometryResult(this.ensureGeometry(result, operation));
          }
          case "centroid":
            return this.geometryResult(this.callUnary("GEOSGetCentroid_r", geometry));
          case "point_on_surface":
            return this.geometryResult(this.callUnary("GEOSPointOnSurface_r", geometry));
          case "bounding_box":
            return this.geometryResult(this.callUnary("GEOSEnvelope_r", geometry));
          case "convex_hull":
            return this.geometryResult(this.callUnary("GEOSConvexHull_r", geometry));
          case "concave_hull": {
            const ratio = this.numberParam(request, "ratio", 0.3);
            const allowHoles = this.booleanParam(request, "allowHoles", false) ? 1 : 0;
            const result = this.api.GEOSConcaveHull_r(this.context, geometry, ratio, allowHoles);
            return this.geometryResult(this.ensureGeometry(result, operation));
          }
          case "line_merge":
            return this.geometryResult(this.callUnary("GEOSLineMerge_r", geometry));
          case "reverse":
            return this.geometryResult(this.callUnary("GEOSReverse_r", geometry));
          case "substring": {
            const start = this.requiredNumberParam(request, "startFraction");
            const end = this.requiredNumberParam(request, "endFraction");
            const result = this.api.GEOSLineSubstring_r(this.context, geometry, start, end);
            return this.geometryResult(this.ensureGeometry(result, operation));
          }
          case "interpolate_point": {
            const value = this.requiredNumberParam(request, "distance");
            const normalized = this.booleanParam(request, "normalized", false);
            const result = normalized
              ? this.api.GEOSInterpolateNormalized_r(this.context, geometry, value)
              : this.api.GEOSInterpolate_r(this.context, geometry, value);
            return this.geometryResult(this.ensureGeometry(result, operation));
          }
          case "project_point": {
            const point = this.requireOther(other, operation);
            const normalized = this.booleanParam(request, "normalized", false);
            const result = normalized
              ? this.api.GEOSProjectNormalized_r(this.context, geometry, point)
              : this.api.GEOSProject_r(this.context, geometry, point);
            if (!Number.isFinite(result)) throw new Error("GEOSProject failed");
            return { scalar: result };
          }
          case "closest_point":
          case "shortest_line":
            return this.nearest(operation, geometry, this.requireOther(other, operation));
          case "polygonize":
            return this.polygonize(geometry);
          case "boundary":
            return this.geometryResult(this.callUnary("GEOSBoundary_r", geometry));
          case "minimum_rotated_rectangle":
            return this.geometryResult(this.callUnary("GEOSMinimumRotatedRectangle_r", geometry));
          case "explode":
            throw this.unsupported(operation, "Array-returning dump/explode remains a P2 contract; use batch or GeometryCollection explicitly.");
          case "geometry_hash":
            throw this.unsupported(operation, "Hashing is implemented by Geometry Core after normalization.");
          default:
            throw this.unsupported(operation);
        }
      } finally {
        if (other) this.destroy(other);
        this.destroy(geometry);
      }
    } catch (error) {
      throw asGeometryServiceError(error, operation);
    }
  }

  async preparedContainsMany(base: GeometryEnvelope, candidates: GeometryEnvelope[]): Promise<boolean[]> {
    await this.initialize();
    const geometry = this.readEnvelope(base);
    const prepared = this.api.GEOSPrepare_r(this.context, geometry);
    if (!prepared) {
      this.destroy(geometry);
      throw new Error("GEOSPrepare failed");
    }
    try {
      const results: boolean[] = [];
      for (const candidate of candidates) {
        const pointer = this.readEnvelope(candidate);
        try {
          results.push(this.charResult(this.api.GEOSPreparedContains_r(this.context, prepared, pointer), "prepared_contains"));
        } finally {
          this.destroy(pointer);
        }
      }
      return results;
    } finally {
      this.api.GEOSPreparedGeom_destroy_r(this.context, prepared);
      this.destroy(geometry);
    }
  }

  private get api(): Geos {
    if (!this.geos || !this.context) throw new Error("GEOS adapter is not initialized");
    return this.geos;
  }

  private requireInput(input: GeometryEnvelope | undefined, operation: GeometryOperation): GeometryEnvelope {
    if (!input) throw new GeometryServiceError({ code: "INVALID_COORDINATE", message: `Operation ${operation} requires input`, operation, recoverable: false });
    return input;
  }

  private requireOther(other: number | undefined, operation: GeometryOperation): number {
    if (!other) throw new GeometryServiceError({ code: "INVALID_COORDINATE", message: `Operation ${operation} requires a second geometry`, operation, recoverable: false });
    return other;
  }

  private readEnvelope(envelope: GeometryEnvelope): GeometryPointer {
    const pointer = this.readGeoJSON(unwrapGeometry(envelope.geometry));
    if (envelope.srid !== undefined) this.api.GEOSSetSRID_r(this.context, pointer, envelope.srid);
    return pointer;
  }

  private readGeoJSON(geometry: Geometry): GeometryPointer {
    const reader = this.api.GEOSGeoJSONReader_create_r(this.context);
    if (!reader) throw new Error("GEOSGeoJSONReader_create failed");
    try {
      const result = this.withUtf8(JSON.stringify(geometry), (pointer) =>
        this.api.GEOSGeoJSONReader_readGeometry_r(this.context, reader, pointer),
      );
      return this.ensureGeometry(result, "parse_geojson");
    } finally {
      this.api.GEOSGeoJSONReader_destroy_r(this.context, reader);
    }
  }

  private readWKT(wkt: string): GeometryPointer {
    const reader = this.api.GEOSWKTReader_create_r(this.context);
    if (!reader) throw new Error("GEOSWKTReader_create failed");
    try {
      const result = this.withUtf8(wkt, (pointer) => this.api.GEOSWKTReader_read_r(this.context, reader, pointer));
      return this.ensureGeometry(result, "parse_wkt");
    } finally {
      this.api.GEOSWKTReader_destroy_r(this.context, reader);
    }
  }

  private readWKBHex(wkbHex: string): GeometryPointer {
    const normalized = wkbHex.trim();
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(normalized)) {
      throw new GeometryServiceError({ code: "INVALID_COORDINATE", message: "WKB must be an even-length hexadecimal string", operation: "parse_wkb", recoverable: false });
    }
    const reader = this.api.GEOSWKBReader_create_r(this.context);
    if (!reader) throw new Error("GEOSWKBReader_create failed");
    try {
      const result = this.withUtf8(normalized, (pointer) => this.api.GEOSWKBReader_readHEX_r(this.context, reader, pointer, normalized.length));
      return this.ensureGeometry(result, "parse_wkb");
    } finally {
      this.api.GEOSWKBReader_destroy_r(this.context, reader);
    }
  }

  private writeGeoJSON(geometry: GeometryPointer, dimension?: 2 | 3): Geometry {
    const writer = this.api.GEOSGeoJSONWriter_create_r(this.context);
    if (!writer) throw new Error("GEOSGeoJSONWriter_create failed");
    try {
      const pointer = this.api.GEOSGeoJSONWriter_writeGeometry_r(this.context, writer, geometry, 0);
      if (!pointer) throw new Error("GEOSGeoJSONWriter_writeGeometry failed");
      try {
        const result = JSON.parse(this.api.Module.UTF8ToString(pointer)) as Geometry;
        return dimension === 2 ? this.force2dGeometry(result) : result;
      } finally {
        this.api.GEOSFree_r(this.context, pointer);
      }
    } finally {
      this.api.GEOSGeoJSONWriter_destroy_r(this.context, writer);
    }
  }

  private writeWKT(geometry: GeometryPointer): string {
    const writer = this.api.GEOSWKTWriter_create_r(this.context);
    if (!writer) throw new Error("GEOSWKTWriter_create failed");
    try {
      this.api.GEOSWKTWriter_setTrim_r(this.context, writer, 1);
      this.api.GEOSWKTWriter_setOutputDimension_r(this.context, writer, this.api.GEOSHasZ_r(this.context, geometry) === 1 ? 3 : 2);
      const pointer = this.api.GEOSWKTWriter_write_r(this.context, writer, geometry);
      if (!pointer) throw new Error("GEOSWKTWriter_write failed");
      try {
        return this.api.Module.UTF8ToString(pointer);
      } finally {
        this.api.GEOSFree_r(this.context, pointer);
      }
    } finally {
      this.api.GEOSWKTWriter_destroy_r(this.context, writer);
    }
  }

  private writeWKBHex(geometry: GeometryPointer, includeSrid: boolean): string {
    const writer = this.api.GEOSWKBWriter_create_r(this.context);
    if (!writer) throw new Error("GEOSWKBWriter_create failed");
    const sizePointer = this.api.Module._malloc(4);
    try {
      this.api.GEOSWKBWriter_setOutputDimension_r(this.context, writer, this.api.GEOSHasZ_r(this.context, geometry) === 1 ? 3 : 2);
      this.api.GEOSWKBWriter_setIncludeSRID_r(this.context, writer, includeSrid ? 1 : 0);
      const pointer = this.api.GEOSWKBWriter_writeHEX_r(this.context, writer, geometry, sizePointer);
      if (!pointer) throw new Error("GEOSWKBWriter_writeHEX failed");
      try {
        const size = this.api.Module.getValue(sizePointer, "i32") as number;
        return new TextDecoder().decode(this.api.Module.HEAPU8.subarray(pointer, pointer + size));
      } finally {
        this.api.GEOSFree_r(this.context, pointer);
      }
    } finally {
      this.api.Module._free(sizePointer);
      this.api.GEOSWKBWriter_destroy_r(this.context, writer);
    }
  }

  private parseGeoJsonRequest(request: OperationRequest): AdapterExecution {
    const raw = request.parameters?.geojson;
    const geometry = typeof raw === "string" ? JSON.parse(raw) as Geometry : raw as Geometry | undefined;
    if (!geometry) throw new Error("parse_geojson requires parameters.geojson");
    const pointer = this.readGeoJSON(geometry);
    try {
      return { geometry: this.writeGeoJSON(pointer) };
    } finally {
      this.destroy(pointer);
    }
  }

  private parseWktRequest(request: OperationRequest): AdapterExecution {
    const wkt = request.parameters?.wkt;
    if (typeof wkt !== "string") throw new Error("parse_wkt requires parameters.wkt");
    const pointer = this.readWKT(wkt);
    try {
      return { geometry: this.writeGeoJSON(pointer) };
    } finally {
      this.destroy(pointer);
    }
  }

  private parseWkbRequest(request: OperationRequest): AdapterExecution {
    const wkbHex = request.parameters?.wkbHex;
    if (typeof wkbHex !== "string") throw new Error("parse_wkb requires parameters.wkbHex");
    const pointer = this.readWKBHex(wkbHex);
    try {
      return { geometry: this.writeGeoJSON(pointer) };
    } finally {
      this.destroy(pointer);
    }
  }

  private collect(request: OperationRequest): AdapterExecution {
    const geometries = (request.inputs ?? []).map((item) => unwrapGeometry(item.geometry));
    return { geometry: { type: "GeometryCollection", geometries } };
  }

  private validationDetail(geometry: GeometryPointer): ValidationDetail {
    const reasonPointerPointer = this.api.Module._malloc(4);
    const locationPointerPointer = this.api.Module._malloc(4);
    this.setPointer(reasonPointerPointer, 0);
    this.setPointer(locationPointerPointer, 0);
    let reason: string | null = null;
    let location: Geometry | null = null;
    try {
      const status = this.api.GEOSisValidDetail_r(this.context, geometry, 0, reasonPointerPointer, locationPointerPointer);
      if (status === 2) throw new Error("GEOS validity check raised an exception");
      const reasonPointer = this.api.Module.getValue(reasonPointerPointer, "i32") as number;
      const locationPointer = this.api.Module.getValue(locationPointerPointer, "i32") as number;
      if (reasonPointer) {
        reason = this.api.Module.UTF8ToString(reasonPointer);
        this.api.GEOSFree_r(this.context, reasonPointer);
      }
      if (locationPointer) {
        location = this.writeGeoJSON(locationPointer);
        this.destroy(locationPointer);
      }
      const type = this.api.GEOSGeomTypeId_r(this.context, geometry);
      const closed = type === 1 || type === 2 ? this.charResult(this.api.GEOSisClosed_r(this.context, geometry), "is_closed") : null;
      const ring = type === 1 ? this.charResult(this.api.GEOSisRing_r(this.context, geometry), "is_ring") : null;
      const rectangle = type === 3 ? status === 1 && this.isAxisAlignedRectangle(this.writeGeoJSON(geometry)) : null;
      return {
        valid: status === 1,
        reason,
        location,
        simple: this.charResult(this.api.GEOSisSimple_r(this.context, geometry), "is_simple"),
        empty: this.charResult(this.api.GEOSisEmpty_r(this.context, geometry), "is_empty"),
        closed,
        ring,
        rectangle,
      };
    } finally {
      this.api.Module._free(reasonPointerPointer);
      this.api.Module._free(locationPointerPointer);
    }
  }

  private buffer(geometry: GeometryPointer, request: OperationRequest): AdapterExecution {
    const distance = this.requiredNumberParam(request, "distance");
    const quadrantSegments = this.integerParam(request, "quadrantSegments", 8);
    const endCap = this.stringParam(request, "endCapStyle", "round") as keyof typeof CAP_STYLE;
    const join = this.stringParam(request, "joinStyle", "round") as keyof typeof JOIN_STYLE;
    const mitreLimit = this.numberParam(request, "mitreLimit", 5);
    const singleSided = this.booleanParam(request, "singleSided", false);
    const result = singleSided
      ? this.api.GEOSSingleSidedBuffer_r(this.context, geometry, distance, quadrantSegments, JOIN_STYLE[join] ?? 1, mitreLimit, distance >= 0 ? 1 : 0)
      : this.api.GEOSBufferWithStyle_r(this.context, geometry, distance, quadrantSegments, CAP_STYLE[endCap] ?? 1, JOIN_STYLE[join] ?? 1, mitreLimit);
    return this.geometryResult(this.ensureGeometry(result, "buffer"));
  }

  private overlay(operation: "intersection" | "union" | "difference" | "symmetric_difference", a: number, b: number, request: OperationRequest): AdapterExecution {
    const grid = request.options?.precision?.gridSize;
    const normal = {
      intersection: "GEOSIntersection_r",
      union: "GEOSUnion_r",
      difference: "GEOSDifference_r",
      symmetric_difference: "GEOSSymDifference_r",
    } as const;
    const precise = {
      intersection: "GEOSIntersectionPrec_r",
      union: "GEOSUnionPrec_r",
      difference: "GEOSDifferencePrec_r",
      symmetric_difference: "GEOSSymDifferencePrec_r",
    } as const;
    const result = grid === undefined
      ? (this.api[normal[operation]] as (context: number, a: number, b: number) => number)(this.context, a, b)
      : (this.api[precise[operation]] as (context: number, a: number, b: number, grid: number) => number)(this.context, a, b, grid);
    return this.geometryResult(this.ensureGeometry(result, operation));
  }

  private predicate(operation: keyof typeof PREDICATES, a: number, b: number): boolean {
    const fn = this.api[PREDICATES[operation]] as (context: number, a: number, b: number) => number;
    return this.charResult(fn(this.context, a, b), operation);
  }

  private relate(a: number, b: number, request: OperationRequest): string | boolean {
    const pattern = request.parameters?.pattern;
    if (typeof pattern === "string") {
      return this.withUtf8(pattern, (pointer) => this.charResult(this.api.GEOSRelatePattern_r(this.context, a, b, pointer), "relate"));
    }
    const pointer = this.api.GEOSRelate_r(this.context, a, b);
    if (!pointer) throw new Error("GEOSRelate failed");
    try {
      return this.api.Module.UTF8ToString(pointer);
    } finally {
      this.api.GEOSFree_r(this.context, pointer);
    }
  }

  private measureUnary(operation: "area" | "length" | "minimum_clearance", geometry: number): number {
    const fnName = { area: "GEOSArea_r", length: "GEOSLength_r", minimum_clearance: "GEOSMinimumClearance_r" } as const;
    return this.outDouble((pointer) => (this.api[fnName[operation]] as (context: number, geometry: number, out: number) => number)(this.context, geometry, pointer), operation);
  }

  private measureBinary(operation: "distance" | "hausdorff_distance", a: number, b: number): number {
    const fnName = operation === "distance" ? "GEOSDistance_r" : "GEOSHausdorffDistance_r";
    return this.outDouble((pointer) => (this.api[fnName] as (context: number, a: number, b: number, out: number) => number)(this.context, a, b, pointer), operation);
  }

  private nearest(operation: "closest_point" | "shortest_line", a: number, b: number): AdapterExecution {
    const sequence = this.api.GEOSNearestPoints_r(this.context, a, b);
    if (!sequence) throw new Error("GEOSNearestPoints failed");
    try {
      const first = this.coordinateAt(sequence, 0);
      const second = this.coordinateAt(sequence, 1);
      return operation === "closest_point"
        ? { geometry: { type: "Point", coordinates: first } }
        : { geometry: { type: "LineString", coordinates: [first, second] } };
    } finally {
      this.api.GEOSCoordSeq_destroy_r(this.context, sequence);
    }
  }

  private coordinateAt(sequence: number, index: number): [number, number] {
    const x = this.api.Module._malloc(8);
    const y = this.api.Module._malloc(8);
    try {
      const ok = this.api.GEOSCoordSeq_getXY_r(this.context, sequence, index, x, y);
      if (ok !== 1) throw new Error("GEOSCoordSeq_getXY failed");
      return [this.api.Module.getValue(x, "double") as number, this.api.Module.getValue(y, "double") as number];
    } finally {
      this.api.Module._free(x);
      this.api.Module._free(y);
    }
  }

  private polygonize(geometry: number): AdapterExecution {
    const arrayPointer = this.api.Module._malloc(4);
    try {
      this.setPointer(arrayPointer, geometry);
      const result = this.api.GEOSPolygonize_valid_r(this.context, arrayPointer, 1);
      return this.geometryResult(this.ensureGeometry(result, "polygonize"));
    } finally {
      this.api.Module._free(arrayPointer);
    }
  }

  private geometryResult(pointer: GeometryPointer): AdapterExecution {
    try {
      return { geometry: this.writeGeoJSON(pointer) };
    } finally {
      this.destroy(pointer);
    }
  }

  private callUnary(name: string, geometry: number): number {
    const fn = (this.api as unknown as Record<string, (context: number, geometry: number) => number>)[name];
    if (!fn) throw new Error(`GEOS function ${name} is unavailable`);
    return this.ensureGeometry(fn(this.context, geometry), name.replace(/_r$/, "") as GeometryOperation);
  }

  private callUnaryNumber(name: string, geometry: number, value: number): number {
    const fn = (this.api as unknown as Record<string, (context: number, geometry: number, value: number) => number>)[name];
    if (!fn) throw new Error(`GEOS function ${name} is unavailable`);
    return this.ensureGeometry(fn(this.context, geometry, value), name.replace(/_r$/, "") as GeometryOperation);
  }

  private clone(geometry: number): number {
    return this.ensureGeometry(this.api.GEOSGeom_clone_r(this.context, geometry), "normalize");
  }

  private destroy(pointer: number): void {
    if (pointer) this.api.GEOSGeom_destroy_r(this.context, pointer);
  }

  private ensureGeometry(pointer: number, operation: GeometryOperation | string): number {
    if (!pointer) {
      throw new GeometryServiceError({
        code: "TOPOLOGY_EXCEPTION",
        message: `GEOS returned no geometry for ${operation}`,
        operation: operation as GeometryOperation,
        recoverable: true,
        suggestion: "Validate or repair the input and consider an explicit precision grid.",
      });
    }
    return pointer;
  }

  private charResult(value: number, operation: string): boolean {
    if (value === 2) throw new Error(`GEOS ${operation} raised an exception`);
    return value === 1;
  }

  private outDouble(action: (pointer: number) => number, operation: string): number {
    const pointer = this.api.Module._malloc(8);
    try {
      if (action(pointer) !== 1) throw new Error(`GEOS ${operation} failed`);
      return this.api.Module.getValue(pointer, "double") as number;
    } finally {
      this.api.Module._free(pointer);
    }
  }

  private withUtf8<T>(value: string, action: (pointer: number) => T): T {
    const size = Buffer.byteLength(value, "utf8") + 1;
    const pointer = this.api.Module._malloc(size);
    try {
      this.api.Module.stringToUTF8(value, pointer, size);
      return action(pointer);
    } finally {
      this.api.Module._free(pointer);
    }
  }

  private setPointer(pointer: number, value: number): void {
    (this.api.Module.setValue as unknown as (pointer: number, value: number, type: string) => void)(pointer, value, "i32");
  }

  private force2dGeometry(geometry: Geometry): Geometry {
    if (geometry.type === "GeometryCollection") {
      return { type: "GeometryCollection", geometries: geometry.geometries.map((child) => this.force2dGeometry(child)) };
    }
    const trim = (value: unknown): unknown => {
      if (!Array.isArray(value)) return value;
      if (value.length > 0 && value.every((item) => typeof item === "number")) return value.slice(0, 2);
      return value.map(trim);
    };
    return { ...geometry, coordinates: trim(geometry.coordinates) } as Geometry;
  }

  private isAxisAlignedRectangle(geometry: Geometry): boolean {
    if (geometry.type !== "Polygon" || geometry.coordinates.length !== 1) return false;
    const ring = geometry.coordinates[0];
    if (!ring || ring.length !== 5) return false;
    const [first, ...rest] = ring;
    const last = rest[rest.length - 1];
    if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) return false;
    const xs = new Set(ring.slice(0, -1).map((position) => position[0]));
    const ys = new Set(ring.slice(0, -1).map((position) => position[1]));
    return xs.size === 2 && ys.size === 2;
  }

  private requiredNumberParam(request: OperationRequest, name: string): number {
    const value = request.parameters?.[name];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${request.operation} requires finite parameters.${name}`);
    return value;
  }

  private numberParam(request: OperationRequest, name: string, fallback: number): number {
    const value = request.parameters?.[name];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  private integerParam(request: OperationRequest, name: string, fallback: number): number {
    return Math.trunc(this.numberParam(request, name, fallback));
  }

  private booleanParam(request: OperationRequest, name: string, fallback: boolean): boolean {
    const value = request.parameters?.[name];
    return typeof value === "boolean" ? value : fallback;
  }

  private stringParam(request: OperationRequest, name: string, fallback: string): string {
    const value = request.parameters?.[name];
    return typeof value === "string" ? value : fallback;
  }

  private unsupported(operation: GeometryOperation, detail?: string): GeometryServiceError {
    return new GeometryServiceError({
      code: "UNSUPPORTED_OPERATION",
      message: detail ?? `Operation ${operation} is not available in this adapter`,
      operation,
      recoverable: false,
    });
  }
}
