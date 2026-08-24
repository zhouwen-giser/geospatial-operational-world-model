export type NetworkAdapterKind = "CATALOG_VECTOR_LAYER" | "OSM_ARTIFACT_PREVIEW";

export interface NetworkDatasetVersion {
  readonly datasetReferenceKey: string;
  readonly datasetVersion: string;
  readonly datasetKind: string;
  readonly contentHash: string;
  readonly dataScopeKey: string;
  readonly datasetScopeKey: string;
}

export interface SourceLineFeature {
  readonly featureReferenceKey: string;
  readonly featureVersion: string;
  readonly layerKey: string;
  readonly contentHash: string;
  readonly coordinates: ReadonlyArray<readonly [longitude: number, latitude: number, elevationMetres?: number]>;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface NormalizedPosition {
  readonly longitudeNanodegrees: number;
  readonly latitudeNanodegrees: number;
  readonly elevationMm: number;
}

export interface MaterializedNetworkFeature extends Omit<SourceLineFeature, "coordinates"> {
  readonly positions: readonly NormalizedPosition[];
}

export interface NetworkBuildPolicy {
  readonly version: string;
  readonly coordinatePrecisionNanodegrees: number;
  readonly defaultElevationMm: number;
  readonly connectAtGradeIntersections: boolean;
}

export interface NetworkBuildRequest {
  readonly dataScopeKey: string;
  readonly datasetScopeKey: string;
  readonly datasetReferenceKey: string;
  readonly datasetVersion: string;
  readonly buildPolicy: NetworkBuildPolicy;
  readonly allowedLayerKeys: readonly string[];
}

export interface MaterializedNetworkBuild {
  readonly adapterKind: NetworkAdapterKind;
  readonly dataset: NetworkDatasetVersion;
  readonly buildPolicy: NetworkBuildPolicy;
  readonly features: readonly MaterializedNetworkFeature[];
  readonly sourceContentHash: string;
  readonly graphIdentityHash: string;
  readonly warnings: readonly string[];
}

export interface NetworkCatalogRepository {
  getDatasetVersion(request: NetworkBuildRequest): Promise<NetworkDatasetVersion | null>;
  listLineFeatures(request: NetworkBuildRequest): Promise<readonly SourceLineFeature[]>;
}
