import type {
  GeometryProviderDefinitionsGeometry,
  GeometryProviderDefinitionsGeometrySummary,
  GeometryProviderDefinitionsOperand,
  GeometryProviderDefinitionsPartialSummary,
  GeometryProviderDefinitionsPocExecution,
  GeometryProviderDefinitionsPocGeometryResult,
  GeometryProviderDefinitionsPocScalarResult,
  GeometryProviderDefinitionsPocValidationResult,
  GeometryProviderDefinitionsPrecision
} from "../../../../packages/platform/contract-runtime/src/index.js";

export type Sha256Digest = `sha256:${string}`;

export const GEOMETRY_OPERATION_IDS = [
  "geometry.validate",
  "geometry.normalize",
  "geometry.force-2d",
  "geometry.remove-repeated-points",
  "geometry.centroid",
  "geometry.bounding-box",
  "geometry.geometry-hash",
  "geometry.predicate",
  "geometry.make-valid",
  "geometry.buffer",
  "geometry.intersection",
  "geometry.union",
  "geometry.difference",
  "geometry.symmetric-difference",
  "geometry.simplify",
  "geometry.simplify-preserve-topology",
  "geometry.convex-hull",
  "geometry.closest-point",
  "geometry.shortest-line"
] as const;

export type GeometryOperationId = (typeof GEOMETRY_OPERATION_IDS)[number];

export const UNSUPPORTED_GEOMETRY_OPERATION_IDS = [
  "geometry.reproject",
  "geometry.geodesic-distance",
  "geometry.geodesic-area",
  "geometry.geodesic-length",
  "geometry.spatial-join",
  "geometry.rasterize",
  "geometry.shortest-path",
  "geometry.h3-polyfill"
] as const;

export type PocGeometryOperation =
  | "validate"
  | "normalize"
  | "force_2d"
  | "remove_repeated_points"
  | "centroid"
  | "bounding_box"
  | "geometry_hash"
  | "make_valid"
  | "buffer"
  | "intersection"
  | "union"
  | "difference"
  | "symmetric_difference"
  | "simplify"
  | "simplify_preserve_topology"
  | "convex_hull"
  | "closest_point"
  | "shortest_line"
  | "equals"
  | "disjoint"
  | "intersects"
  | "touches"
  | "crosses"
  | "within"
  | "contains"
  | "overlaps"
  | "covers"
  | "covered_by"
  | "relate";

export interface ApprovedGeometryEndpoint {
  endpointId: string;
  baseUrl: string;
  approvalStatus: "APPROVED";
  configurationDigest: Sha256Digest;
}

export interface GeometryDeploymentAttestation {
  sourceZipSha256: Sha256Digest;
  openApiSha256: Sha256Digest;
  engine: "GEOS-WASM-WORKER-POOL";
  geosVersion: string;
  integration: "geos-wasm";
  integrationVersion: string;
  workerPoolEnabled: true;
  projectLicense: "MIT";
}

export interface GeometryProviderBridgeOptions {
  endpoint: ApprovedGeometryEndpoint;
  attestation: GeometryDeploymentAttestation;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  receiptId?: () => string;
  maximumInFlight?: number;
  maximumQueueSize?: number;
}

export interface GeometryEnvelope {
  geometry: GeometryProviderDefinitionsGeometry;
  srid?: number;
  coordinateLayout?: "XY" | "XYZ";
}

export interface PocOperationRequest {
  operation: PocGeometryOperation;
  input?: GeometryEnvelope;
  other?: GeometryEnvelope;
  parameters?: Record<string, unknown>;
  options?: {
    mode: "strict";
    repairInvalid: false;
    normalizeOutput: false;
    outputFormat: "geojson";
    planar?: boolean;
    precision?: { gridSize: number; keepCollapsed?: boolean };
  };
}

export type GeometryOperand = GeometryProviderDefinitionsOperand;
export type GeometryPrecision = GeometryProviderDefinitionsPrecision;
export type PocGeometryResult = GeometryProviderDefinitionsPocGeometryResult;
export type PocScalarResult = GeometryProviderDefinitionsPocScalarResult;
export type PocValidationResult = GeometryProviderDefinitionsPocValidationResult;
export type PocExecution = GeometryProviderDefinitionsPocExecution;
export type GeometrySummary = GeometryProviderDefinitionsGeometrySummary;
export type PartialGeometrySummary = GeometryProviderDefinitionsPartialSummary;

export interface GeometryUpstreamErrorPayload {
  error?: {
    code?: string;
    message?: string;
    recoverable?: boolean;
    suggestion?: string;
    details?: Record<string, unknown>;
  };
}
