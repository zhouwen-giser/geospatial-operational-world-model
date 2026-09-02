import type { ResourceLimits } from "./types.js";

export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxBodyBytes: 16 * 1024 * 1024,
  maxVerticesPerGeometry: 100_000,
  maxTotalVerticesPerBatch: 1_000_000,
  maxBatchItems: 1_000,
  maxGeometryCollectionDepth: 4,
  maxCoordinateNestingDepth: 8,
  syncTimeoutMs: 2_000,
});

export function resourceLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ResourceLimits {
  const read = (key: string, fallback: number): number => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    maxBodyBytes: read("GEOMETRY_MAX_BODY_BYTES", DEFAULT_RESOURCE_LIMITS.maxBodyBytes),
    maxVerticesPerGeometry: read("GEOMETRY_MAX_VERTICES", DEFAULT_RESOURCE_LIMITS.maxVerticesPerGeometry),
    maxTotalVerticesPerBatch: read("GEOMETRY_MAX_BATCH_VERTICES", DEFAULT_RESOURCE_LIMITS.maxTotalVerticesPerBatch),
    maxBatchItems: read("GEOMETRY_MAX_BATCH_ITEMS", DEFAULT_RESOURCE_LIMITS.maxBatchItems),
    maxGeometryCollectionDepth: read("GEOMETRY_MAX_COLLECTION_DEPTH", DEFAULT_RESOURCE_LIMITS.maxGeometryCollectionDepth),
    maxCoordinateNestingDepth: read("GEOMETRY_MAX_COORDINATE_DEPTH", DEFAULT_RESOURCE_LIMITS.maxCoordinateNestingDepth),
    syncTimeoutMs: read("GEOMETRY_SYNC_TIMEOUT_MS", DEFAULT_RESOURCE_LIMITS.syncTimeoutMs),
  };
}
