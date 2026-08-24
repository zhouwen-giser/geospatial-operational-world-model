import { graphIdentityHash } from "./identity.js";
import { sha256 } from "./canonical.js";
import type {
  MaterializedNetworkBuild,
  MaterializedNetworkFeature,
  NetworkBuildPolicy,
  NetworkBuildRequest,
  NetworkCatalogRepository,
  NetworkDatasetVersion,
  SourceLineFeature
} from "./types.js";

const referencePattern = /^wrf_[0-9a-f]{32}$/u;
const hashPattern = /^sha256:[0-9a-f]{64}$/u;

function assertRequest(request: NetworkBuildRequest): void {
  if (!request.dataScopeKey || !request.datasetScopeKey || !referencePattern.test(request.datasetReferenceKey)) {
    throw new Error("network build scope or dataset reference is invalid");
  }
  if (!request.datasetVersion || !request.buildPolicy.version || request.allowedLayerKeys.length === 0) {
    throw new Error("network build request is incomplete");
  }
  if (!Number.isInteger(request.buildPolicy.coordinatePrecisionNanodegrees) ||
      request.buildPolicy.coordinatePrecisionNanodegrees <= 0 ||
      !Number.isInteger(request.buildPolicy.defaultElevationMm)) {
    throw new Error("network build policy fixed-point values are invalid");
  }
}

function normalizeCoordinate(value: number, precision: number): number {
  if (!Number.isFinite(value)) throw new Error("network source coordinate is not finite");
  return Math.round(value * 1_000_000_000 / precision) * precision;
}

function materializeFeature(feature: SourceLineFeature, policy: NetworkBuildPolicy): MaterializedNetworkFeature {
  if (!referencePattern.test(feature.featureReferenceKey) || !hashPattern.test(feature.contentHash)) {
    throw new Error("network source feature identity is invalid");
  }
  if (feature.coordinates.length < 2) throw new Error("network source geometry is zero-length");
  const positions = feature.coordinates.map(([longitude, latitude, elevationMetres]) => ({
    longitudeNanodegrees: normalizeCoordinate(longitude, policy.coordinatePrecisionNanodegrees),
    latitudeNanodegrees: normalizeCoordinate(latitude, policy.coordinatePrecisionNanodegrees),
    elevationMm: elevationMetres === undefined ? policy.defaultElevationMm : Math.round(elevationMetres * 1000)
  }));
  const distinct = new Set(positions.map((position) => `${position.longitudeNanodegrees}:${position.latitudeNanodegrees}:${position.elevationMm}`));
  if (distinct.size < 2) throw new Error("network source geometry is zero-length after normalization");
  return { ...feature, positions };
}

function assemble(
  dataset: NetworkDatasetVersion,
  buildPolicy: NetworkBuildPolicy,
  sourceFeatures: readonly SourceLineFeature[],
  adapterKind: MaterializedNetworkBuild["adapterKind"],
  warnings: readonly string[]
): MaterializedNetworkBuild {
  if (dataset.datasetKind !== "NETWORK") throw new Error("dataset version is not NETWORK");
  if (!hashPattern.test(dataset.contentHash)) throw new Error("dataset content hash is invalid");
  const features = sourceFeatures
    .map((feature) => materializeFeature(feature, buildPolicy))
    .sort((left, right) => left.featureReferenceKey.localeCompare(right.featureReferenceKey) || left.featureVersion.localeCompare(right.featureVersion));
  if (features.length === 0) throw new Error("network source contains no authorized line features");
  const sourceContentHash = sha256(features.map(({ featureReferenceKey, featureVersion, layerKey, contentHash, positions, properties }) => ({
    featureReferenceKey, featureVersion, layerKey, contentHash, positions, properties
  })));
  return {
    adapterKind,
    dataset,
    buildPolicy,
    features,
    sourceContentHash,
    graphIdentityHash: graphIdentityHash({
      datasetReferenceKey: dataset.datasetReferenceKey,
      datasetVersion: dataset.datasetVersion,
      datasetContentHash: dataset.contentHash,
      buildPolicyVersion: buildPolicy.version,
      sourceContentHash
    }),
    warnings
  };
}

export class CatalogNetworkBuildAdapter {
  constructor(private readonly repository: NetworkCatalogRepository) {}

  async materialize(request: NetworkBuildRequest): Promise<MaterializedNetworkBuild> {
    assertRequest(request);
    const dataset = await this.repository.getDatasetVersion(request);
    if (!dataset || dataset.dataScopeKey !== request.dataScopeKey || dataset.datasetScopeKey !== request.datasetScopeKey) {
      throw new Error("network dataset version is unavailable");
    }
    const features = await this.repository.listLineFeatures(request);
    const allowedLayers = new Set(request.allowedLayerKeys);
    if (features.some((feature) => !allowedLayers.has(feature.layerKey))) {
      throw new Error("network source contains an unauthorized layer");
    }
    return assemble(dataset, request.buildPolicy, features, "CATALOG_VECTOR_LAYER", []);
  }
}

export function materializeOsmArtifactPreview(input: {
  readonly dataset: NetworkDatasetVersion;
  readonly buildPolicy: NetworkBuildPolicy;
  readonly artifactContentHash: string;
  readonly license: "ODbL-1.0";
  readonly attribution: "© OpenStreetMap contributors";
  readonly sourceUrl: string;
  readonly sourceVersion: string;
  readonly features: readonly SourceLineFeature[];
}): MaterializedNetworkBuild {
  if (!hashPattern.test(input.artifactContentHash)) throw new Error("OSM artifact hash is invalid");
  if (input.license !== "ODbL-1.0" || input.attribution !== "© OpenStreetMap contributors" ||
      !input.sourceUrl.startsWith("https://") || !input.sourceVersion) {
    throw new Error("OSM artifact provenance or ODbL attribution is incomplete");
  }
  return assemble(input.dataset, input.buildPolicy, input.features, "OSM_ARTIFACT_PREVIEW", [
    "OSM_ARTIFACT_PREVIEW is not a Stable catalog authority",
    `artifact=${input.artifactContentHash}`,
    `license=${input.license}`,
    `attribution=${input.attribution}`,
    `source=${input.sourceUrl}@${input.sourceVersion}`
  ]);
}
