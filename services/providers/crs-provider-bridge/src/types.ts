export type Sha256Digest = `sha256:${string}`;

export interface ApprovedCrsEndpoint {
  endpointId: string;
  baseUrl: string;
  approvalStatus: "APPROVED";
  configurationDigest: Sha256Digest;
}

export interface CrsDeploymentAttestation {
  sourceZipSha256: Sha256Digest;
  openApiSha256: Sha256Digest;
  projVersion: string;
  integration: "gdal-async";
  integrationVersion: string;
  projDbVersion: string;
  projDbSha256: Sha256Digest;
  gridBundleVersion: string;
  gridBundleSha256: Sha256Digest;
  strictBestOperation: true;
  networkEnabled: false;
}

export interface CrsProviderBridgeOptions {
  endpoint: ApprovedCrsEndpoint;
  attestation: CrsDeploymentAttestation;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  receiptId?: () => string;
}

export type CrsOperationId =
  | "crs.check-source"
  | "crs.normalize.point"
  | "crs.normalize.points"
  | "crs.normalize.geometry"
  | "crs.normalize.feature"
  | "crs.normalize.feature-collection";

export interface CrsWarning {
  code:
    | "SOURCE_ALREADY_WGS84"
    | "GRID_FALLBACK"
    | "LOW_ACCURACY_TRANSFORMATION"
    | "Z_NOT_TRANSFORMED"
    | "BBOX_DROPPED";
  message: string;
}

export interface TransformationProvenance {
  engine: "PROJ";
  engineVersion: string;
  integration: "gdal-async";
  integrationVersion: string;
  sourceCrs: string;
  targetCrs: "EPSG:4326";
  strictBestOperation: true;
  networkEnabled: false;
  cacheHit: boolean;
}

export interface NormalizationMetadata {
  crs: "EPSG:4326";
  axisOrder: ["longitude", "latitude"];
  coordinateCount: number;
  zTransformed: false;
  transformation: TransformationProvenance;
  warnings: CrsWarning[];
}
