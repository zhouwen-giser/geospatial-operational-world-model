import { createHash } from "node:crypto";
import {
  DEFAULT_RESOURCE_LIMITS,
  GeometryServiceError,
  asGeometryServiceError,
  geometryEnvelopeSchema,
  inspectGeometry,
  isLikelyGeographicSrid,
  unwrapGeometry,
  type BatchItemFailure,
  type BatchItemSuccess,
  type BatchRequest,
  type BatchResult,
  type CommonOptions,
  type Geometry,
  type GeometryEngineAdapter,
  type GeometryEnvelope,
  type GeometryMetadata,
  type GeometryOperation,
  type GeometryResult,
  type OperationRequest,
  type ResourceLimits,
  type ScalarResult,
  type ValidationResult,
} from "@geospatial/geometry-contract";
import { GeosWasmAdapter } from "@geospatial/geometry-adapter-geos";

const TOPOLOGY_SENSITIVE = new Set<GeometryOperation>([
  "buffer", "intersection", "union", "difference", "symmetric_difference", "unary_union", "coverage_union",
  "equals", "disjoint", "intersects", "touches", "crosses", "within", "contains", "overlaps", "covers", "covered_by", "relate",
  "simplify_preserve_topology", "coverage_simplify", "snap", "polygonize",
]);

const PLANAR_ACK_REQUIRED = new Set<GeometryOperation>([
  "buffer", "area", "length", "distance", "hausdorff_distance", "minimum_clearance",
]);

export type GeometryCoreResult = GeometryResult | ScalarResult | ValidationResult;

export interface GeometryCoreOptions {
  adapter?: GeometryEngineAdapter;
  limits?: Partial<ResourceLimits>;
  now?: () => number;
}

export class GeometryCore {
  readonly adapter: GeometryEngineAdapter;
  readonly limits: ResourceLimits;
  private readonly now: () => number;

  constructor(options: GeometryCoreOptions = {}) {
    this.adapter = options.adapter ?? new GeosWasmAdapter();
    this.limits = { ...DEFAULT_RESOURCE_LIMITS, ...options.limits };
    this.now = options.now ?? (() => performance.now());
  }

  async initialize(): Promise<void> {
    await this.adapter.initialize();
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }

  async execute(original: OperationRequest): Promise<GeometryCoreResult> {
    await this.initialize();
    const started = this.now();
    const warnings: string[] = [];
    const request = this.validateAndCloneRequest(original);
    const operation = request.operation;
    try {
      this.assertServiceBoundary(operation);
      this.assertSridCompatibility(request);
      this.assertPlanarAcknowledgement(request, warnings);
      await this.prepareTopologyInputs(request, warnings);

      if (operation === "geometry_hash") {
        return await this.hashResult(request, started, warnings);
      }

      let adapterResult = await this.adapter.execute(request);
      if (adapterResult.geometry && this.effectiveOptions(request).normalizeOutput && operation !== "normalize") {
        const normalized = await this.adapter.execute({ operation: "normalize", input: { geometry: adapterResult.geometry } });
        if (normalized.geometry) {
          adapterResult = { ...adapterResult, geometry: normalized.geometry };
          warnings.push("Output was explicitly normalized; component and ring ordering may change.");
        }
      }

      const durationMs = this.now() - started;
      if (durationMs > this.limits.syncTimeoutMs) {
        throw new GeometryServiceError({
          code: "OPERATION_TIMEOUT",
          message: `Operation completed after the synchronous budget (${durationMs.toFixed(1)}ms > ${this.limits.syncTimeoutMs}ms)`,
          operation,
          recoverable: true,
          suggestion: "Reduce geometry size, simplify first, or execute in an isolated worker/job tier.",
          details: { preemptive: false, durationMs, limitMs: this.limits.syncTimeoutMs },
        });
      }
      const execution = {
        engine: this.adapter.name,
        engineVersion: this.adapter.version,
        durationMs: Number(durationMs.toFixed(3)),
        operation,
        deterministicScope: "engine-version-input-options" as const,
      };
      const allWarnings = [...warnings, ...(adapterResult.warnings ?? [])];

      if (adapterResult.detail) {
        const input = request.input!;
        const inspected = inspectGeometry(input.geometry);
        const summary = this.metadata(inspected.geometry, input, adapterResult.detail.valid);
        return {
          result: adapterResult.detail.valid,
          detail: adapterResult.detail,
          summary,
          warnings: allWarnings,
          execution,
        };
      }
      if (adapterResult.geometry) {
        const inspected = inspectGeometry(adapterResult.geometry);
        const outputBytes = Buffer.byteLength(JSON.stringify(adapterResult.geometry), "utf8");
        if (inspected.vertexCount > this.limits.maxVerticesPerGeometry || outputBytes > this.limits.maxBodyBytes) {
          throw new GeometryServiceError({
            code: "RESOURCE_LIMIT",
            message: "Geometry result exceeds the synchronous output budget",
            operation,
            recoverable: true,
            suggestion: "Use smaller inputs/parameters or a future asynchronous streaming result tier.",
            details: {
              outputVertexCount: inspected.vertexCount,
              maxOutputVertices: this.limits.maxVerticesPerGeometry,
              outputBytes,
              maxOutputBytes: this.limits.maxBodyBytes,
            },
          });
        }
        const validation = await this.adapter.execute({ operation: "validate", input: { geometry: adapterResult.geometry } });
        const inputType = request.input ? unwrapGeometry(request.input.geometry).type : undefined;
        const summary = this.metadata(adapterResult.geometry, request.input, validation.detail?.valid, inputType);
        return { result: inspected.geometry, summary, warnings: allWarnings, execution };
      }
      if (adapterResult.scalar !== undefined) {
        return {
          result: adapterResult.scalar,
          summary: { units: this.scalarUnits(operation) },
          warnings: allWarnings,
          execution,
        };
      }
      throw new Error(`Adapter returned no result for ${operation}`);
    } catch (error) {
      throw asGeometryServiceError(error, operation);
    }
  }

  async batch(batch: BatchRequest): Promise<BatchResult> {
    if (batch.items.length > this.limits.maxBatchItems) {
      throw new GeometryServiceError({
        code: "TOO_MANY_GEOMETRIES",
        message: `Batch contains ${batch.items.length} items; limit is ${this.limits.maxBatchItems}`,
        operation: batch.operation,
        recoverable: true,
        suggestion: "Split the batch while preserving client-side sequence numbers.",
      });
    }
    let totalVertices = 0;
    for (const item of batch.items) {
      for (const envelope of [item.input, item.other, ...(item.inputs ?? [])]) {
        if (envelope) totalVertices += inspectGeometry(envelope.geometry).vertexCount;
      }
    }
    if (totalVertices > this.limits.maxTotalVerticesPerBatch) {
      throw new GeometryServiceError({
        code: "TOO_MANY_VERTICES",
        message: `Batch contains ${totalVertices} vertices; total limit is ${this.limits.maxTotalVerticesPerBatch}`,
        operation: batch.operation,
        recoverable: true,
        suggestion: "Split the batch or simplify inputs.",
      });
    }

    const results: Array<BatchItemSuccess | BatchItemFailure> = [];
    for (let index = 0; index < batch.items.length; index += 1) {
      const item = batch.items[index]!;
      try {
        const value = await this.execute({ ...item, operation: batch.operation });
        results.push({ index, status: "success", value });
      } catch (error) {
        const serviceError = asGeometryServiceError(error, batch.operation);
        results.push({ index, status: "error", error: serviceError.toJSON().error });
        if (batch.continueOnError === false) break;
      }
    }
    const succeeded = results.filter((item) => item.status === "success").length;
    return {
      results,
      summary: { total: batch.items.length, succeeded, failed: results.length - succeeded, inputOrderPreserved: true },
    };
  }

  validate(input: GeometryEnvelope): Promise<ValidationResult> {
    return this.execute({ operation: "validate", input }) as Promise<ValidationResult>;
  }

  makeValid(input: GeometryEnvelope, options?: CommonOptions): Promise<GeometryResult> {
    return this.execute({ operation: "make_valid", input, ...(options ? { options } : {}) }) as Promise<GeometryResult>;
  }

  buffer(input: GeometryEnvelope, distance: number, parameters: Record<string, unknown> = {}, options?: CommonOptions): Promise<GeometryResult> {
    return this.execute({ operation: "buffer", input, parameters: { ...parameters, distance }, ...(options ? { options } : {}) }) as Promise<GeometryResult>;
  }

  overlay(operation: "intersection" | "union" | "difference" | "symmetric_difference", a: GeometryEnvelope, b: GeometryEnvelope, options?: CommonOptions): Promise<GeometryResult> {
    return this.execute({ operation, input: a, other: b, ...(options ? { options } : {}) }) as Promise<GeometryResult>;
  }

  predicate(operation: "contains" | "within" | "intersects" | "touches" | "overlaps" | "disjoint" | "covers" | "covered_by" | "crosses" | "equals", a: GeometryEnvelope, b: GeometryEnvelope, options?: CommonOptions): Promise<ScalarResult<boolean>> {
    return this.execute({ operation, input: a, other: b, ...(options ? { options } : {}) }) as Promise<ScalarResult<boolean>>;
  }

  private validateAndCloneRequest(original: OperationRequest): OperationRequest {
    const request: OperationRequest = { operation: original.operation };
    if (original.input) request.input = geometryEnvelopeSchema.parse(original.input) as unknown as GeometryEnvelope;
    if (original.other) request.other = geometryEnvelopeSchema.parse(original.other) as unknown as GeometryEnvelope;
    if (original.inputs) request.inputs = original.inputs.map((item) => geometryEnvelopeSchema.parse(item) as unknown as GeometryEnvelope);
    if (original.parameters) request.parameters = { ...original.parameters };
    if (original.options) request.options = { ...original.options };
    for (const [index, envelope] of [request.input, request.other, ...(request.inputs ?? [])].entries()) {
      if (envelope) this.assertResourceLimits(envelope, index);
    }
    return request;
  }

  private assertResourceLimits(envelope: GeometryEnvelope, geometryIndex: number): void {
    const inspected = inspectGeometry(envelope.geometry);
    const serializedBytes = Buffer.byteLength(JSON.stringify(unwrapGeometry(envelope.geometry)), "utf8");
    if (serializedBytes > this.limits.maxBodyBytes) {
      throw new GeometryServiceError({
        code: "GEOMETRY_TOO_LARGE",
        message: `Serialized geometry is ${serializedBytes} bytes; limit is ${this.limits.maxBodyBytes}`,
        geometryIndex,
        recoverable: true,
        suggestion: "Use WKB transport in the future high-volume tier or simplify/split the geometry.",
      });
    }
    if (inspected.vertexCount > this.limits.maxVerticesPerGeometry) {
      throw new GeometryServiceError({
        code: "TOO_MANY_VERTICES",
        message: `Geometry has ${inspected.vertexCount} vertices; synchronous limit is ${this.limits.maxVerticesPerGeometry}`,
        geometryIndex,
        recoverable: true,
        suggestion: "Simplify or split the geometry, or use an isolated asynchronous tier.",
      });
    }
    if (inspected.collectionDepth > this.limits.maxGeometryCollectionDepth || inspected.coordinateNestingDepth > this.limits.maxCoordinateNestingDepth) {
      throw new GeometryServiceError({
        code: "NESTING_TOO_DEEP",
        message: "Geometry nesting exceeds the configured limit",
        geometryIndex,
        recoverable: true,
        details: { collectionDepth: inspected.collectionDepth, coordinateNestingDepth: inspected.coordinateNestingDepth },
      });
    }
    if (inspected.coordinateDimension > 4) {
      throw new GeometryServiceError({ code: "INVALID_COORDINATE", message: "Coordinates may contain at most X/Y/Z/M ordinates", geometryIndex, recoverable: false });
    }
    if (envelope.coordinateLayout === "XYM" || envelope.coordinateLayout === "XYZM" || inspected.coordinateDimension === 4) {
      throw new GeometryServiceError({
        code: "UNSUPPORTED_GEOMETRY_TYPE",
        message: "M/XYZM is not enabled in the GEOS 3.13 WASM MVP; use force_2d or WKB through a future GEOS 3.15 worker adapter",
        geometryIndex,
        recoverable: true,
      });
    }
  }

  private assertSridCompatibility(request: OperationRequest): void {
    if (request.input?.srid !== undefined && request.other?.srid !== undefined && request.input.srid !== request.other.srid) {
      throw new GeometryServiceError({
        code: "SRID_MISMATCH",
        message: `SRID metadata differs (${request.input.srid} vs ${request.other.srid}); Geometry Service never reprojects`,
        operation: request.operation,
        recoverable: true,
        suggestion: "Reproject both inputs in CRS Service, then retry with matching SRID metadata.",
      });
    }
  }

  private assertServiceBoundary(operation: GeometryOperation): void {
    const delegated = {
      reproject: ["CRS_TRANSFORMATION_UNSUPPORTED", "Delegate coordinate transformation to CRS Service."],
      geodesic_distance: ["GEODESIC_OPERATION_UNSUPPORTED", "Delegate geodesic measurement to CRS/Geodesic Measurement Service."],
      geodesic_area: ["GEODESIC_OPERATION_UNSUPPORTED", "Delegate geodesic measurement to CRS/Geodesic Measurement Service."],
      geodesic_length: ["GEODESIC_OPERATION_UNSUPPORTED", "Delegate geodesic measurement to CRS/Geodesic Measurement Service."],
      spatial_join: ["SPATIAL_DATASET_OPERATION_UNSUPPORTED", "Delegate dataset joins/indexing/aggregation to Spatial Analysis Service."],
      rasterize: ["RASTER_OPERATION_UNSUPPORTED", "Delegate rasterization, sampling and warping to Raster Service."],
      shortest_path: ["ROUTING_OPERATION_UNSUPPORTED", "Delegate path and route optimization to Routing Service."],
      h3_polyfill: ["H3_OPERATION_UNSUPPORTED", "Validate/repair the polygon here, then delegate cell conversion to H3 Toolkit."],
    } as const;
    const boundary = delegated[operation as keyof typeof delegated];
    if (!boundary) return;
    throw new GeometryServiceError({
      code: boundary[0],
      message: `${operation} is outside the Geometry Service boundary`,
      operation,
      recoverable: true,
      suggestion: boundary[1],
    });
  }

  private assertPlanarAcknowledgement(request: OperationRequest, warnings: string[]): void {
    if (!PLANAR_ACK_REQUIRED.has(request.operation)) return;
    const options = this.effectiveOptions(request);
    const geographic = [request.input, request.other].some((item) => isLikelyGeographicSrid(item?.srid));
    if (!geographic) return;
    if (!options.planar) {
      throw new GeometryServiceError({
        code: "PLANAR_ACKNOWLEDGEMENT_REQUIRED",
        message: `${request.operation} on geographic-coordinate SRID metadata is planar, not geodesic`,
        operation: request.operation,
        recoverable: true,
        suggestion: "Set options.planar=true only if degree/coordinate-space units are intended, otherwise delegate to CRS/Geodesic Service.",
      });
    }
    warnings.push("Geographic-coordinate input was processed as a Cartesian plane; values are coordinate-space units, never metres/metres².");
  }

  private async prepareTopologyInputs(request: OperationRequest, warnings: string[]): Promise<void> {
    if (!TOPOLOGY_SENSITIVE.has(request.operation)) return;
    const options = this.effectiveOptions(request);
    for (const key of ["input", "other"] as const) {
      let envelope = request[key];
      if (!envelope) continue;
      if (options.precision?.gridSize !== undefined) {
        const reduced = await this.adapter.execute({
          operation: "reduce_precision",
          input: envelope,
          parameters: { gridSize: options.precision.gridSize },
          options: { precision: options.precision },
        });
        if (!reduced.geometry) throw new Error("Precision reduction returned no geometry");
        envelope = { ...envelope, geometry: reduced.geometry };
        request[key] = envelope;
        warnings.push(`${key} was reduced to precision grid ${options.precision.gridSize} before the topology operation.`);
      }
      const validation = await this.adapter.execute({ operation: "validate", input: envelope });
      if (validation.detail?.valid !== false) continue;
      if (options.mode !== "lenient" || !options.repairInvalid) {
        throw new GeometryServiceError({
          code: "INVALID_GEOMETRY",
          message: validation.detail?.reason ?? "Invalid geometry",
          operation: request.operation,
          recoverable: true,
          suggestion: "Call geometry.make_valid explicitly, or use lenient mode with repairInvalid=true.",
          details: { location: validation.detail?.location ?? null, implicitRepair: false },
        });
      }
      const repaired = await this.adapter.execute({ operation: "make_valid", input: envelope });
      if (!repaired.geometry) throw new Error("GEOS make_valid returned no geometry");
      request[key] = { ...envelope, geometry: repaired.geometry };
      warnings.push(`${key} was explicitly repaired under lenient+repairInvalid; geometry type or coordinates may have changed.`);
    }
  }

  private effectiveOptions(request: OperationRequest): CommonOptions {
    return { ...(request.input?.options ?? {}), ...(request.options ?? {}) };
  }

  private metadata(geometry: Geometry, envelope?: GeometryEnvelope, valid?: boolean, inputType?: string): GeometryMetadata {
    const inspected = inspectGeometry(geometry);
    const typeChanged = inputType !== undefined && inputType !== inspected.type;
    return {
      type: inspected.type,
      empty: inspected.empty,
      vertexCount: inspected.vertexCount,
      coordinateDimension: inspected.coordinateDimension,
      ...(valid === undefined ? {} : { valid }),
      ...(envelope?.srid === undefined ? {} : { srid: envelope.srid }),
      ...(envelope?.coordinateLayout === undefined ? {} : { coordinateLayout: envelope.coordinateLayout }),
      ...(inputType === undefined ? {} : { inputType, typeChanged }),
      ...(inspected.bbox === undefined ? {} : { bbox: inspected.bbox }),
      ...(envelope?.options?.precision?.gridSize === undefined ? {} : { precisionGridSize: envelope.options.precision.gridSize }),
    };
  }

  private scalarUnits(operation: GeometryOperation): NonNullable<GeometryMetadata["units"]> {
    if (operation === "area") return "coordinate-space-squared";
    if (["length", "distance", "hausdorff_distance", "minimum_clearance", "project_point"].includes(operation)) return "coordinate-space";
    return "dimensionless";
  }

  private async hashResult(request: OperationRequest, started: number, warnings: string[]): Promise<ScalarResult<string>> {
    if (!request.input) throw new Error("geometry_hash requires input");
    let geometry = unwrapGeometry(request.input.geometry);
    const grid = request.options?.precision?.gridSize;
    if (grid !== undefined) {
      const reduced = await this.adapter.execute({ operation: "reduce_precision", input: { geometry }, options: { precision: { gridSize: grid } }, parameters: { gridSize: grid } });
      if (reduced.geometry) geometry = reduced.geometry;
    }
    const normalized = await this.adapter.execute({ operation: "normalize", input: { geometry } });
    if (!normalized.geometry) throw new Error("Normalization failed before hash");
    const canonical = JSON.stringify(normalized.geometry);
    const result = createHash("sha256").update(canonical).digest("hex");
    warnings.push("Hash is canonical only within the recorded engine version, precision grid, and coordinate layout.");
    return {
      result,
      summary: { units: "dimensionless" },
      warnings,
      execution: {
        engine: this.adapter.name,
        engineVersion: this.adapter.version,
        durationMs: Number((this.now() - started).toFixed(3)),
        operation: "geometry_hash",
        deterministicScope: "engine-version-input-options",
      },
    };
  }
}
