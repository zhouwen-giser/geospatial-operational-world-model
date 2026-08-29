import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  canonicalSha256
} from "../../packages/platform/contract-runtime/src/index.js";

export type Sha256Digest = `sha256:${string}`;
export type JsonValue = unknown;
export type JsonObject = Record<string, unknown>;

export interface ReferenceKey {
  namespace: "gowm";
  kind: string;
  id: `wrf_${string}`;
  version: string;
}

export interface SampleWorldReferenceMapEntry {
  fixtureKey: string;
  fixtureReferenceKey: string;
  scope: string;
  datasetScope: string;
  targetKind: string;
  entityId: string;
  referenceId: `wrf_${string}`;
  identityReferenceKey: ReferenceKey;
  currentCatalogReferenceKey?: ReferenceKey;
  currentWorldReferenceKey?: ReferenceKey;
}

export interface SampleWorldInputs {
  sourceRoot: string;
  sourceFixtureHash: Sha256Digest;
  spec: JsonObject;
  catalog: JsonObject;
  features: {
    visible: JsonObject;
    hidden: JsonObject;
  };
  objects: JsonObject[];
  references: JsonObject[];
  observations: JsonObject[];
  mutations: JsonObject[];
  expectedCases: JsonObject[];
}

export interface SampleWorldArtifact {
  path: string;
  bytes: number;
  sha256: Sha256Digest;
  content: string;
}

export interface SampleWorldRealizationManifest {
  schemaVersion: "1.0";
  fixtureId: typeof SAMPLE_WORLD_FIXTURE_ID;
  fixtureVersion: typeof SAMPLE_WORLD_FIXTURE_VERSION;
  sourceFixtureHash: Sha256Digest;
  realizationId: string;
  epoch: string;
  generatedAt: string;
  artifacts: Array<{ path: string; bytes: number; sha256: Sha256Digest }>;
  realizationHash: Sha256Digest;
}

export interface SampleWorldRealization {
  fixture: {
    id: typeof SAMPLE_WORLD_FIXTURE_ID;
    version: typeof SAMPLE_WORLD_FIXTURE_VERSION;
    namespace: string;
    epoch: string;
    realizationId: string;
    seedHash: Sha256Digest;
    sourceFixtureHash: Sha256Digest;
    generatedArtifactHash: Sha256Digest;
    realizationHash: Sha256Digest;
  };
  spec: JsonObject;
  catalog: JsonObject;
  features: {
    visible: JsonObject;
    hidden: JsonObject;
  };
  objects: JsonObject[];
  references: JsonObject[];
  observations: JsonObject[];
  mutations: JsonObject[];
  expectedCases: JsonObject[];
  referenceMap: {
    schemaVersion: "1.0";
    fixtureId: typeof SAMPLE_WORLD_FIXTURE_ID;
    fixtureVersion: typeof SAMPLE_WORLD_FIXTURE_VERSION;
    sourceFixtureHash: Sha256Digest;
    realizationId: string;
    entries: SampleWorldReferenceMapEntry[];
  };
  artifacts: SampleWorldArtifact[];
  manifest: SampleWorldRealizationManifest;
}

export interface RealizeSampleWorldOptions {
  epoch: string;
  seed?: string;
  sourceRoot?: string;
  outputDir?: string;
}

export const SAMPLE_WORLD_FIXTURE_ID = "gowm-wsgs-sample-world" as const;
export const SAMPLE_WORLD_FIXTURE_VERSION = "1.0.0" as const;
export const DEFAULT_SAMPLE_WORLD_SEED = "gowm-wsgs-sample-world/identity-v1";
export const DEFAULT_SAMPLE_WORLD_SOURCE_ROOT = fileURLToPath(
  new URL("../../test-data/wsgs-sample-world/v1/", import.meta.url)
);

const UUID_NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const INPUT_FILES = [
  "catalog.json",
  "expected-results.json",
  "hidden-features.geojson",
  "mutation-plan.json",
  "objects.json",
  "observations-template.json",
  "references.json",
  "visible-features.geojson",
  "world-spec.json"
] as const;

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function loadSampleWorldInputs(
  sourceRoot = DEFAULT_SAMPLE_WORLD_SOURCE_ROOT
): Promise<SampleWorldInputs> {
  const absoluteRoot = resolve(sourceRoot);
  const parsedEntries = await Promise.all(INPUT_FILES.map(async (path) => {
    const bytes = await readFile(resolve(absoluteRoot, path), "utf8");
    return [path, JSON.parse(bytes) as unknown] as const;
  }));
  const parsed = new Map<string, unknown>(parsedEntries);
  const spec = requireObject(parsed.get("world-spec.json"), "world-spec.json");
  const catalog = requireObject(parsed.get("catalog.json"), "catalog.json");
  const visible = requireFeatureCollection(parsed.get("visible-features.geojson"), "visible-features.geojson");
  const hidden = requireFeatureCollection(parsed.get("hidden-features.geojson"), "hidden-features.geojson");
  const objects = requireRecordArray(parsed.get("objects.json"), "objects.json");
  const references = requireRecordArray(parsed.get("references.json"), "references.json");
  const observations = requireRecordArray(parsed.get("observations-template.json"), "observations-template.json");
  const mutations = requireRecordArray(parsed.get("mutation-plan.json"), "mutation-plan.json");
  const expectedCases = requireRecordArray(parsed.get("expected-results.json"), "expected-results.json");

  validateSource(spec, catalog, visible, hidden, objects, references, observations, mutations, expectedCases);
  const sourceFixtureHash = canonicalSha256(
    parsedEntries
      .map(([path, value]) => ({ path, value }))
      .sort((left, right) => compareCanonicalText(left.path, right.path))
  );
  return {
    sourceRoot: absoluteRoot,
    sourceFixtureHash,
    spec,
    catalog,
    features: { visible, hidden },
    objects,
    references,
    observations,
    mutations,
    expectedCases
  };
}

export async function realizeSampleWorld(
  options: RealizeSampleWorldOptions
): Promise<SampleWorldRealization> {
  const epoch = normalizeEpoch(options.epoch);
  const seed = normalizeSeed(options.seed ?? DEFAULT_SAMPLE_WORLD_SEED);
  const inputs = await loadSampleWorldInputs(options.sourceRoot);
  const namespace = requiredString(inputs.spec.namespace, "world-spec.namespace");
  const seedHash = canonicalSha256(seed);
  const identityNamespace = deterministicUuidV5(
    `${SAMPLE_WORLD_FIXTURE_ID}:${SAMPLE_WORLD_FIXTURE_VERSION}:identity`,
    UUID_NAMESPACE_URL
  );
  const realizationId = `sample-realization-${deterministicUuidV5(
    canonicalJson({ epoch, seedHash, sourceFixtureHash: inputs.sourceFixtureHash }),
    identityNamespace
  )}`;
  const spec = normalizeSpec(inputs.spec);
  const referenceEntries = buildReferenceMapEntries(inputs, namespace, identityNamespace, realizationId);
  const referenceByFixtureKey = new Map(referenceEntries.map((entry) => [entry.fixtureKey, entry]));
  const features = {
    visible: realizeFeatureCollection(inputs.features.visible, referenceByFixtureKey),
    hidden: realizeFeatureCollection(inputs.features.hidden, referenceByFixtureKey)
  };
  const objects = realizeObjects(inputs.objects, referenceByFixtureKey);
  const catalog = realizeCatalog(inputs, features, objects, referenceByFixtureKey, realizationId);
  const references = realizeReferences(inputs.references, referenceByFixtureKey);
  const observations = realizeObservations(
    inputs.observations,
    inputs.objects,
    referenceByFixtureKey,
    epoch,
    realizationId,
    identityNamespace,
    inputs.sourceFixtureHash
  );
  const mutations = realizeMutations(
    inputs.mutations,
    referenceByFixtureKey,
    epoch,
    realizationId,
    identityNamespace,
    inputs.sourceFixtureHash
  );
  const expectedCases = normalizeExpectedCases(
    inputs.expectedCases,
    inputs,
    features,
    referenceByFixtureKey
  );
  const referenceMap = {
    schemaVersion: "1.0" as const,
    fixtureId: SAMPLE_WORLD_FIXTURE_ID,
    fixtureVersion: SAMPLE_WORLD_FIXTURE_VERSION,
    sourceFixtureHash: inputs.sourceFixtureHash,
    realizationId,
    entries: referenceEntries
  };
  const artifacts = buildArtifacts({
    "generated/catalog.json": catalog,
    "generated/expected-cases.json": expectedCases,
    "generated/hidden-features.geojson": features.hidden,
    "generated/mutations.json": mutations,
    "generated/objects.json": objects,
    "generated/observations.json": observations,
    "generated/references.json": references,
    "generated/visible-features.geojson": features.visible,
    "generated/world-spec.json": spec,
    "sample-world-reference-map.json": referenceMap
  });
  const artifactDescriptors = artifacts.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const generatedArtifactHash = canonicalSha256(artifactDescriptors);
  const manifestCore = {
    schemaVersion: "1.0" as const,
    fixtureId: SAMPLE_WORLD_FIXTURE_ID,
    fixtureVersion: SAMPLE_WORLD_FIXTURE_VERSION,
    sourceFixtureHash: inputs.sourceFixtureHash,
    realizationId,
    epoch,
    generatedAt: epoch,
    artifacts: artifactDescriptors
  };
  const realizationHash = canonicalSha256(manifestCore);
  const manifest: SampleWorldRealizationManifest = { ...manifestCore, realizationHash };
  const realization: SampleWorldRealization = {
    fixture: {
      id: SAMPLE_WORLD_FIXTURE_ID,
      version: SAMPLE_WORLD_FIXTURE_VERSION,
      namespace,
      epoch,
      realizationId,
      seedHash,
      sourceFixtureHash: inputs.sourceFixtureHash,
      generatedArtifactHash,
      realizationHash
    },
    spec,
    catalog,
    features,
    objects,
    references,
    observations,
    mutations,
    expectedCases,
    referenceMap,
    artifacts,
    manifest
  };
  if (options.outputDir !== undefined) {
    await writeSampleWorldRealization(realization, options.outputDir);
  }
  return realization;
}

export async function writeSampleWorldRealization(
  realization: SampleWorldRealization,
  outputDir: string
): Promise<void> {
  const absoluteOutput = resolve(outputDir);
  for (const artifact of [...realization.artifacts].sort((left, right) => compareCanonicalText(left.path, right.path))) {
    const target = resolve(absoluteOutput, artifact.path);
    if (!isWithin(absoluteOutput, target)) throw new Error(`Unsafe sample-world artifact path: ${artifact.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.content, "utf8");
  }
  const manifestPath = resolve(absoluteOutput, "sample-world-realization-manifest.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, canonicalBytes(realization.manifest), "utf8");
}

export function stableReferenceId(
  namespace: string,
  scope: string,
  targetKind: string,
  fixtureKey: string
): `wrf_${string}` {
  const digest = createHash("sha256")
    .update(`${namespace}\0${scope}\0${targetKind}\0${fixtureKey}`, "utf8")
    .digest("hex");
  return `wrf_${digest.slice(0, 32)}`;
}

export function deterministicUuidV5(name: string, namespaceUuid: string): string {
  const namespace = uuidBytes(namespaceUuid);
  const digest = createHash("sha1").update(namespace).update(name, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildReferenceMapEntries(
  inputs: SampleWorldInputs,
  namespace: string,
  identityNamespace: string,
  realizationId: string
): SampleWorldReferenceMapEntry[] {
  const scopes = scopeMap(inputs.spec);
  const datasets = requireRecordArray(inputs.catalog.datasets, "catalog.datasets");
  const layers = requireRecordArray(inputs.catalog.layers, "catalog.layers");
  const datasetByKey = new Map(datasets.map((dataset) => [
    requiredString(dataset.fixtureDatasetKey, "catalog.dataset.fixtureDatasetKey"),
    dataset
  ]));
  const datasetVersions = new Map(datasets.map((dataset) => {
    const key = requiredString(dataset.fixtureDatasetKey, "catalog.dataset.fixtureDatasetKey");
    const version = requiredString(dataset.version, `catalog.dataset.${key}.version`);
    return [key, version === "REALIZATION" ? realizationId : version] as const;
  }));
  const entries = new Map<string, SampleWorldReferenceMapEntry>();

  for (const dataset of datasets) {
    const fixtureKey = requiredString(dataset.fixtureDatasetKey, "catalog.dataset.fixtureDatasetKey");
    const scope = requiredString(dataset.scope, `catalog.dataset.${fixtureKey}.scope`);
    addReferenceEntry(entries, referenceEntry({
      fixtureKey,
      fixtureReferenceKey: `dataset:${fixtureKey}`,
      scope,
      datasetScope: requireDatasetScope(scopes, scope),
      targetKind: "DATASET",
      namespace,
      identityNamespace,
      catalogVersion: requireMapValue(datasetVersions, fixtureKey, "dataset version")
    }));
  }
  for (const layer of layers) {
    const fixtureKey = requiredString(layer.fixtureLayerKey, "catalog.layer.fixtureLayerKey");
    const datasetKey = requiredString(layer.dataset, `catalog.layer.${fixtureKey}.dataset`);
    const dataset = requireMapValue(datasetByKey, datasetKey, "layer dataset");
    const scope = requiredString(dataset.scope, `catalog.dataset.${datasetKey}.scope`);
    addReferenceEntry(entries, referenceEntry({
      fixtureKey,
      fixtureReferenceKey: `layer:${fixtureKey}`,
      scope,
      datasetScope: requireDatasetScope(scopes, scope),
      targetKind: "LAYER",
      namespace,
      identityNamespace,
      catalogVersion: requireMapValue(datasetVersions, datasetKey, "layer dataset version")
    }));
  }

  const layerByKey = new Map(layers.map((layer) => [
    requiredString(layer.fixtureLayerKey, "catalog.layer.fixtureLayerKey"),
    layer
  ]));
  const allFeatures = [
    ...requireRecordArray(inputs.features.visible.features, "visible.features"),
    ...requireRecordArray(inputs.features.hidden.features, "hidden.features")
  ];
  const featureCatalogVersions = new Map(allFeatures.map((feature) => {
    const properties = requireObject(feature.properties, "feature.properties");
    const fixtureKey = requiredString(properties.fixtureFeatureKey, "feature.fixtureFeatureKey");
    const layerKey = requiredString(properties.layer, `feature.${fixtureKey}.layer`);
    const layer = requireMapValue(layerByKey, layerKey, "feature layer");
    const datasetKey = requiredString(layer.dataset, `catalog.layer.${layerKey}.dataset`);
    return [fixtureKey, requireMapValue(datasetVersions, datasetKey, "feature catalog version")] as const;
  }));
  for (const source of inputs.references) {
    const fixtureReferenceKey = requiredString(source.fixtureReferenceKey, "reference.fixtureReferenceKey");
    const fixtureKey = requiredString(source.targetFixtureKey, `${fixtureReferenceKey}.targetFixtureKey`);
    const targetKind = requiredString(source.targetKind, `${fixtureReferenceKey}.targetKind`);
    const scope = requiredString(source.scope, `${fixtureReferenceKey}.scope`);
    addReferenceEntry(entries, referenceEntry({
      fixtureKey,
      fixtureReferenceKey,
      scope,
      datasetScope: requireDatasetScope(scopes, scope),
      targetKind,
      namespace,
      identityNamespace,
      ...(targetKind === "LAYER_FEATURE"
        ? { catalogVersion: requireMapValue(featureCatalogVersions, fixtureKey, "feature catalog version") }
        : targetKind === "WORLD_OBJECT"
          ? { worldVersion: "1" }
          : {})
    }));
  }
  return [...entries.values()].sort((left, right) =>
    compareCanonicalText(left.fixtureKey, right.fixtureKey) || compareCanonicalText(left.targetKind, right.targetKind)
  );
}

function referenceEntry(input: {
  fixtureKey: string;
  fixtureReferenceKey: string;
  scope: string;
  datasetScope: string;
  targetKind: string;
  namespace: string;
  identityNamespace: string;
  catalogVersion?: string;
  worldVersion?: string;
}): SampleWorldReferenceMapEntry {
  const referenceId = stableReferenceId(input.namespace, input.scope, input.targetKind, input.fixtureKey);
  const common = { namespace: "gowm" as const, kind: input.targetKind, id: referenceId };
  const entry: SampleWorldReferenceMapEntry = {
    fixtureKey: input.fixtureKey,
    fixtureReferenceKey: input.fixtureReferenceKey,
    scope: input.scope,
    datasetScope: input.datasetScope,
    targetKind: input.targetKind,
    entityId: deterministicUuidV5(
      canonicalJson({ fixtureKey: input.fixtureKey, scope: input.scope, targetKind: input.targetKind }),
      input.identityNamespace
    ),
    referenceId,
    identityReferenceKey: { ...common, version: "1" }
  };
  if (input.catalogVersion !== undefined) {
    entry.currentCatalogReferenceKey = { ...common, version: input.catalogVersion };
  }
  if (input.worldVersion !== undefined) {
    entry.currentWorldReferenceKey = { ...common, version: input.worldVersion };
  }
  return entry;
}

function realizeCatalog(
  inputs: SampleWorldInputs,
  features: { visible: JsonObject; hidden: JsonObject },
  objects: JsonObject[],
  referenceByFixtureKey: Map<string, SampleWorldReferenceMapEntry>,
  realizationId: string
): JsonObject {
  const sourceDatasets = requireRecordArray(inputs.catalog.datasets, "catalog.datasets");
  const sourceLayers = requireRecordArray(inputs.catalog.layers, "catalog.layers");
  const datasets = sortRecords(sourceDatasets, "fixtureDatasetKey").map((dataset) => {
    const fixtureKey = requiredString(dataset.fixtureDatasetKey, "catalog.dataset.fixtureDatasetKey");
    const mapping = requireMapValue(referenceByFixtureKey, fixtureKey, "dataset reference");
    const sourceVersion = requiredString(dataset.version, `catalog.dataset.${fixtureKey}.version`);
    const version = sourceVersion === "REALIZATION" ? realizationId : sourceVersion;
    const dataKind = requiredString(dataset.kind, `catalog.dataset.${fixtureKey}.kind`);
    const lineageSource = requireObject(dataset.provenance, `catalog.dataset.${fixtureKey}.provenance`).source;
    return compact({
      ...dataset,
      version,
      datasetId: mapping.entityId,
      identityReferenceKey: mapping.identityReferenceKey,
      currentCatalogReferenceKey: requireCatalogReference(mapping),
      layers: sortStrings(dataset.layers, `catalog.dataset.${fixtureKey}.layers`),
      schemaRef: `urn:gowm:wsgs-sample-world:dataset:${fixtureKey}:1.0`,
      schemaHash: canonicalSha256({ dataKind, fixtureKey, sourceVersion }),
      spatialExtent: datasetExtent(dataset, sourceLayers, features, objects),
      lineage: typeof lineageSource === "string" ? [lineageSource] : [],
      freshnessPolicy: { mode: "VERSIONED", currentVersion: version },
      supportedCapabilities: supportedCapabilities(dataKind),
      syntheticTestData: true
    });
  });
  const datasetVersionByKey = new Map(datasets.map((dataset) => [
    requiredString(dataset.fixtureDatasetKey, "realized catalog dataset key"),
    requiredString(dataset.version, "realized catalog dataset version")
  ]));
  const layers = sortRecords(sourceLayers, "fixtureLayerKey").map((layer) => {
    const fixtureKey = requiredString(layer.fixtureLayerKey, "catalog.layer.fixtureLayerKey");
    const datasetKey = requiredString(layer.dataset, `catalog.layer.${fixtureKey}.dataset`);
    const mapping = requireMapValue(referenceByFixtureKey, fixtureKey, "layer reference");
    return {
      ...layer,
      layerId: mapping.entityId,
      version: requireMapValue(datasetVersionByKey, datasetKey, "layer version"),
      identityReferenceKey: mapping.identityReferenceKey,
      currentCatalogReferenceKey: requireCatalogReference(mapping),
      datasetReferenceKey: requireCatalogReference(
        requireMapValue(referenceByFixtureKey, datasetKey, "layer dataset reference")
      ),
      syntheticTestData: true
    };
  });
  return { datasets, layers };
}

function realizeFeatureCollection(
  collection: JsonObject,
  referenceByFixtureKey: Map<string, SampleWorldReferenceMapEntry>
): JsonObject {
  const features = sortFeatures(requireRecordArray(collection.features, "feature collection features"))
    .map((feature) => {
      const properties = requireObject(feature.properties, "feature.properties");
      const fixtureKey = requiredString(properties.fixtureFeatureKey, "feature.fixtureFeatureKey");
      const mapping = requireMapValue(referenceByFixtureKey, fixtureKey, "feature reference");
      return {
        ...feature,
        id: mapping.entityId,
        properties: {
          ...properties,
          sourceFeatureId: typeof feature.id === "string" ? feature.id : fixtureKey,
          featureId: mapping.entityId,
          fixtureId: SAMPLE_WORLD_FIXTURE_ID,
          fixtureVersion: SAMPLE_WORLD_FIXTURE_VERSION,
          identityReferenceKey: mapping.identityReferenceKey,
          currentCatalogReferenceKey: requireCatalogReference(mapping),
          syntheticTestData: true
        }
      };
    });
  return { ...collection, features };
}

function realizeObjects(
  sourceObjects: JsonObject[],
  referenceByFixtureKey: Map<string, SampleWorldReferenceMapEntry>
): JsonObject[] {
  return sortRecords(sourceObjects, "fixtureObjectKey").map((object) => {
    const fixtureKey = requiredString(object.fixtureObjectKey, "object.fixtureObjectKey");
    const mapping = requireMapValue(referenceByFixtureKey, fixtureKey, "object reference");
    return {
      ...object,
      aliases: sortStrings(object.aliases, `object.${fixtureKey}.aliases`),
      codes: sortStrings(object.codes, `object.${fixtureKey}.codes`),
      objectId: mapping.entityId,
      fixtureId: SAMPLE_WORLD_FIXTURE_ID,
      fixtureVersion: SAMPLE_WORLD_FIXTURE_VERSION,
      identityReferenceKey: mapping.identityReferenceKey,
      currentWorldReferenceKey: requireWorldReference(mapping),
      syntheticTestData: true
    };
  });
}

function realizeReferences(
  sourceReferences: JsonObject[],
  referenceByFixtureKey: Map<string, SampleWorldReferenceMapEntry>
): JsonObject[] {
  return sortRecords(sourceReferences, "fixtureReferenceKey").map((reference) => {
    const fixtureKey = requiredString(reference.targetFixtureKey, "reference.targetFixtureKey");
    const mapping = requireMapValue(referenceByFixtureKey, fixtureKey, "reference mapping");
    return compact({
      ...reference,
      aliases: sortStrings(reference.aliases, `reference.${fixtureKey}.aliases`),
      codes: sortStrings(reference.codes, `reference.${fixtureKey}.codes`),
      targetId: mapping.entityId,
      referenceId: mapping.referenceId,
      identityReferenceKey: mapping.identityReferenceKey,
      currentCatalogReferenceKey: mapping.currentCatalogReferenceKey,
      currentWorldReferenceKey: mapping.currentWorldReferenceKey,
      fixtureId: SAMPLE_WORLD_FIXTURE_ID,
      fixtureVersion: SAMPLE_WORLD_FIXTURE_VERSION
    });
  });
}

function realizeObservations(
  sourceObservations: JsonObject[],
  sourceObjects: JsonObject[],
  referenceByFixtureKey: Map<string, SampleWorldReferenceMapEntry>,
  epoch: string,
  realizationId: string,
  identityNamespace: string,
  sourceFixtureHash: Sha256Digest
): JsonObject[] {
  const objectByKey = new Map(sourceObjects.map((object) => [
    requiredString(object.fixtureObjectKey, "object.fixtureObjectKey"),
    object
  ]));
  return sortRecords(sourceObservations, "observationKey").map((source) => {
    const observationKey = requiredString(source.observationKey, "observation.observationKey");
    const fixtureKey = requiredString(source.subjectFixtureKey, `${observationKey}.subjectFixtureKey`);
    const mapping = requireMapValue(referenceByFixtureKey, fixtureKey, "observation reference");
    const object = requireMapValue(objectByKey, fixtureKey, "observation object");
    const observedOffsetMs = requiredInteger(source.observedOffsetMs, `${observationKey}.observedOffsetMs`);
    const receivedOffsetMs = requiredInteger(source.receivedOffsetMs, `${observationKey}.receivedOffsetMs`);
    const metadata = requireObject(source.metadata, `${observationKey}.metadata`);
    const realized = {
      ...source,
      observationId: deterministicUuidV5(
        `${realizationId}:observation:${observationKey}`,
        identityNamespace
      ),
      sourceRecordKey: observationKey,
      originKind: "SYNTHETIC",
      subject: {
        type: requiredString(object.objectType, `object.${fixtureKey}.objectType`),
        id: mapping.entityId
      },
      identityReferenceKey: mapping.identityReferenceKey,
      currentWorldReferenceKey: requireWorldReference(mapping),
      observedAt: offsetTime(epoch, observedOffsetMs),
      receivedAt: offsetTime(epoch, receivedOffsetMs),
      metadata: {
        ...metadata,
        sourceFixtureHash,
        realizationId,
        syntheticTestData: true
      }
    };
    return { ...realized, payloadHash: canonicalSha256(realized) };
  });
}

function realizeMutations(
  sourceMutations: JsonObject[],
  referenceByFixtureKey: Map<string, SampleWorldReferenceMapEntry>,
  epoch: string,
  realizationId: string,
  identityNamespace: string,
  sourceFixtureHash: Sha256Digest
): JsonObject[] {
  return sortRecords(sourceMutations, "scenarioId").map((source) => {
    const scenarioId = requiredString(source.scenarioId, "mutation.scenarioId");
    const fixtureKey = requiredString(source.subjectFixtureKey, `${scenarioId}.subjectFixtureKey`);
    const mapping = requireMapValue(referenceByFixtureKey, fixtureKey, "mutation reference");
    const observedOffsetMs = requiredInteger(source.observedOffsetMs, `${scenarioId}.observedOffsetMs`);
    const receivedOffsetMs = requiredInteger(source.receivedOffsetMs, `${scenarioId}.receivedOffsetMs`);
    const current = requireWorldReference(mapping);
    const realized = {
      ...source,
      observationId: deterministicUuidV5(
        `${realizationId}:mutation:${scenarioId}:${requiredString(source.idempotencyKey, `${scenarioId}.idempotencyKey`)}`,
        identityNamespace
      ),
      identityReferenceKey: mapping.identityReferenceKey,
      previousWorldReferenceKey: current,
      resultingWorldReferenceKey: { ...current, version: "2" },
      observedAt: offsetTime(epoch, observedOffsetMs),
      receivedAt: offsetTime(epoch, receivedOffsetMs),
      metadata: {
        fixtureId: SAMPLE_WORLD_FIXTURE_ID,
        fixtureVersion: SAMPLE_WORLD_FIXTURE_VERSION,
        sourceFixtureHash,
        realizationId,
        syntheticTestData: true
      }
    };
    return { ...realized, payloadHash: canonicalSha256(realized) };
  });
}

function normalizeExpectedCases(
  sourceCases: JsonObject[],
  inputs: SampleWorldInputs,
  realizedFeatures: { visible: JsonObject; hidden: JsonObject },
  referenceByFixtureKey: Map<string, SampleWorldReferenceMapEntry>
): JsonObject[] {
  const sourceObjectsByKey = new Map(inputs.objects.map((object) => [
    requiredString(object.fixtureObjectKey, "object.fixtureObjectKey"),
    object
  ]));
  const allFeatures = [
    ...requireRecordArray(realizedFeatures.visible.features, "realized visible features"),
    ...requireRecordArray(realizedFeatures.hidden.features, "realized hidden features")
  ];
  const featureByKey = new Map(allFeatures.map((feature) => {
    const properties = requireObject(feature.properties, "realized feature properties");
    return [requiredString(properties.fixtureFeatureKey, "realized feature fixture key"), feature] as const;
  }));
  return sortRecords(sourceCases, "caseId").map((sourceCase) => {
    const caseId = requiredString(sourceCase.caseId, "expected case caseId");
    const operationId = requiredString(sourceCase.operationId, `${caseId}.operationId`);
    const inputTemplate = requireObject(sourceCase.inputTemplate, `${caseId}.inputTemplate`);
    const expectedFixtureKeys = sourceCase.expectedFixtureKeys === undefined
      ? []
      : sortStrings(sourceCase.expectedFixtureKeys, `${caseId}.expectedFixtureKeys`);
    const expectedReferenceKeys = expectedFixtureKeys.map((fixtureKey) =>
      requireMapValue(referenceByFixtureKey, fixtureKey, `${caseId} expected reference`).referenceId
    ).sort();
    return compact({
      ...sourceCase,
      inputTemplate: normalizeGatewayInput(
        caseId,
        operationId,
        inputTemplate,
        sourceObjectsByKey,
        featureByKey,
        allFeatures,
        referenceByFixtureKey
      ),
      expectedFixtureKeys: expectedFixtureKeys.length > 0 ? expectedFixtureKeys : undefined,
      expectedReferenceKeys: expectedReferenceKeys.length > 0 ? expectedReferenceKeys : undefined,
      forbiddenFixtureKeys: sourceCase.forbiddenFixtureKeys === undefined
        ? undefined
        : sortStrings(sourceCase.forbiddenFixtureKeys, `${caseId}.forbiddenFixtureKeys`)
    });
  });
}

function normalizeGatewayInput(
  caseId: string,
  operationId: string,
  input: JsonObject,
  objectByKey: Map<string, JsonObject>,
  featureByKey: Map<string, JsonObject>,
  allFeatures: JsonObject[],
  referenceByFixtureKey: Map<string, SampleWorldReferenceMapEntry>
): JsonObject {
  if (operationId === "reference.resolve") {
    return {
      schemaVersion: "1.0",
      mentions: [{
        mentionId: caseId,
        surfaceText: requiredString(input.surfaceText, `${caseId}.surfaceText`)
      }],
      context: { anchorReferenceKeys: [] },
      limitPerMention: 20
    };
  }
  if (operationId.startsWith("world.")) {
    const fixtureKey = requiredString(input.referenceFixtureKey, `${caseId}.referenceFixtureKey`);
    const mapping = requireMapValue(referenceByFixtureKey, fixtureKey, `${caseId} reference`);
    return {
      schemaVersion: "1.0",
      referenceKey: operationId === "world.get-geometry" && mapping.currentCatalogReferenceKey !== undefined
        ? mapping.currentCatalogReferenceKey
        : mapping.currentWorldReferenceKey ?? mapping.identityReferenceKey
    };
  }
  if (operationId === "catalog.search") {
    return compact({
      schemaVersion: "1.0",
      dataKinds: input.dataKinds === undefined ? undefined : sortStrings(input.dataKinds, `${caseId}.dataKinds`),
      currentOnly: input.currentOnly,
      limit: 100
    });
  }
  if (operationId === "spatial.find-nearby") {
    const fixtureKey = requiredString(input.centerReferenceFixtureKey, `${caseId}.centerReferenceFixtureKey`);
    const object = requireMapValue(objectByKey, fixtureKey, `${caseId} center object`);
    const geometry = requireObject(object.initialGeometry, `${caseId} center geometry`);
    return compact({
      location: requireJsonArray(geometry.coordinates, `${caseId} center coordinates`),
      radiusM: requiredFinite(input.maximumDistanceM, `${caseId}.maximumDistanceM`),
      objectTypes: input.objectTypes === undefined ? undefined : sortStrings(input.objectTypes, `${caseId}.objectTypes`),
      limit: 1000,
      includeGeometry: true,
      crs: "EPSG:4326"
    });
  }
  if (operationId === "spatial.find-in-area") {
    const fixtureKey = requiredString(input.areaReferenceFixtureKey, `${caseId}.areaReferenceFixtureKey`);
    const feature = requireMapValue(featureByKey, fixtureKey, `${caseId} area feature`);
    return compact({
      geometry: requireObject(feature.geometry, `${caseId} area geometry`),
      objectTypes: input.objectTypes === undefined ? undefined : sortStrings(input.objectTypes, `${caseId}.objectTypes`),
      limit: 1000,
      includeGeometry: true,
      crs: "EPSG:4326"
    });
  }
  if (operationId === "spatial.find-intersections") {
    const fixtureKey = requiredString(input.geometryReferenceFixtureKey, `${caseId}.geometryReferenceFixtureKey`);
    const layerFixtureKey = requiredString(input.layerFixtureKey, `${caseId}.layerFixtureKey`);
    const feature = requireMapValue(featureByKey, fixtureKey, `${caseId} geometry feature`);
    const candidates = allFeatures.filter((candidate) => {
      const properties = requireObject(candidate.properties, "candidate feature properties");
      return properties.layer === layerFixtureKey;
    }).map((candidate) => {
      const properties = requireObject(candidate.properties, "candidate feature properties");
      const key = requiredString(properties.fixtureFeatureKey, "candidate fixture key");
      return requireCatalogReference(requireMapValue(referenceByFixtureKey, key, "candidate reference"));
    }).sort((left, right) => compareCanonicalText(left.id, right.id));
    return {
      geometry: requireObject(feature.geometry, `${caseId} intersection geometry`),
      candidateReferences: candidates,
      limit: 1000,
      includeGeometry: true,
      crs: "EPSG:4326"
    };
  }
  return { ...input };
}

function normalizeSpec(source: JsonObject): JsonObject {
  return {
    ...source,
    scopes: sortRecords(requireRecordArray(source.scopes, "world-spec.scopes"), "name"),
    datasets: sortRecords(requireRecordArray(source.datasets, "world-spec.datasets"), "fixtureDatasetKey")
      .map((dataset) => ({
        ...dataset,
        layers: sortStrings(dataset.layers, "world-spec.dataset.layers")
      })),
    features: sortStrings(source.features, "world-spec.features"),
    objects: sortStrings(source.objects, "world-spec.objects"),
    references: sortStrings(source.references, "world-spec.references"),
    observationTemplates: sortStrings(source.observationTemplates, "world-spec.observationTemplates"),
    mutations: sortStrings(source.mutations, "world-spec.mutations")
  };
}

function buildArtifacts(values: Record<string, JsonValue>): SampleWorldArtifact[] {
  return Object.entries(values).sort(([left], [right]) => compareCanonicalText(left, right)).map(([path, value]) => {
    const content = canonicalBytes(value);
    return {
      path,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: hashBytes(content),
      content
    };
  });
}

function canonicalBytes(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function hashBytes(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function validateSource(
  spec: JsonObject,
  catalog: JsonObject,
  visible: JsonObject,
  hidden: JsonObject,
  objects: JsonObject[],
  references: JsonObject[],
  observations: JsonObject[],
  mutations: JsonObject[],
  expectedCases: JsonObject[]
): void {
  if (spec.schemaVersion !== "gowm-wsgs-sample-world/1.0") throw new Error("Unsupported sample-world schemaVersion");
  if (spec.fixtureId !== SAMPLE_WORLD_FIXTURE_ID) throw new Error("Unexpected sample-world fixtureId");
  if (spec.fixtureVersion !== SAMPLE_WORLD_FIXTURE_VERSION) throw new Error("Unexpected sample-world fixtureVersion");
  if (spec.coordinateReferenceSystem !== "EPSG:4326") throw new Error("Sample world must use EPSG:4326");
  if (objects.length === 0 || references.length === 0 || observations.length === 0 || mutations.length === 0) {
    throw new Error("Sample-world source collections must not be empty");
  }
  if (requireRecordArray(catalog.datasets, "catalog.datasets").length !== 4) throw new Error("Sample world requires four datasets");
  if (requireRecordArray(catalog.layers, "catalog.layers").length !== 6) throw new Error("Sample world requires six layers");
  if (requireRecordArray(visible.features, "visible.features").length !== 7) throw new Error("Sample world requires seven visible features");
  if (requireRecordArray(hidden.features, "hidden.features").length !== 2) throw new Error("Sample world requires two hidden features");
  const objectKeys = new Set(objects.map((object) => requiredString(object.fixtureObjectKey, "object.fixtureObjectKey")));
  const featureKeys = new Set([
    ...requireRecordArray(visible.features, "visible.features"),
    ...requireRecordArray(hidden.features, "hidden.features")
  ].map((feature) => requiredString(
    requireObject(feature.properties, "feature.properties").fixtureFeatureKey,
    "feature.fixtureFeatureKey"
  )));
  const targetKeys = new Set([...objectKeys, ...featureKeys]);
  const fixtureReferenceKeys = new Set<string>();
  for (const reference of references) {
    const referenceKey = requiredString(reference.fixtureReferenceKey, "reference.fixtureReferenceKey");
    if (fixtureReferenceKeys.has(referenceKey)) throw new Error(`Duplicate fixtureReferenceKey: ${referenceKey}`);
    fixtureReferenceKeys.add(referenceKey);
    const targetKey = requiredString(reference.targetFixtureKey, `${referenceKey}.targetFixtureKey`);
    if (!targetKeys.has(targetKey)) throw new Error(`Unknown reference target: ${targetKey}`);
  }
  for (const observation of observations) {
    const key = requiredString(observation.observationKey, "observation.observationKey");
    const subject = requiredString(observation.subjectFixtureKey, `${key}.subjectFixtureKey`);
    if (!objectKeys.has(subject)) throw new Error(`Unknown observation subject: ${subject}`);
    const observed = requiredInteger(observation.observedOffsetMs, `${key}.observedOffsetMs`);
    const received = requiredInteger(observation.receivedOffsetMs, `${key}.receivedOffsetMs`);
    if (received < observed) throw new Error(`Observation ${key} is received before it is observed`);
  }
  const caseIds = expectedCases.map((value) => requiredString(value.caseId, "expected case caseId"));
  if (new Set(caseIds).size !== caseIds.length) throw new Error("Duplicate sample-world expected case IDs");
}

function datasetExtent(
  dataset: JsonObject,
  layers: JsonObject[],
  features: { visible: JsonObject; hidden: JsonObject },
  objects: JsonObject[]
): JsonObject | undefined {
  const fixtureKey = requiredString(dataset.fixtureDatasetKey, "dataset.fixtureDatasetKey");
  const layerKeys = new Set(sortStrings(dataset.layers, `dataset.${fixtureKey}.layers`));
  const geometries: JsonObject[] = [];
  for (const feature of [
    ...requireRecordArray(features.visible.features, "visible.features"),
    ...requireRecordArray(features.hidden.features, "hidden.features")
  ]) {
    const properties = requireObject(feature.properties, "feature.properties");
    if (layerKeys.has(requiredString(properties.layer, "feature.layer"))) {
      geometries.push(requireObject(feature.geometry, "feature.geometry"));
    }
  }
  if (requiredString(dataset.kind, `dataset.${fixtureKey}.kind`) === "CURRENT_PROJECTION") {
    for (const object of objects) geometries.push(requireObject(object.initialGeometry, "object.initialGeometry"));
  }
  for (const layer of layers) {
    const layerKey = requiredString(layer.fixtureLayerKey, "layer.fixtureLayerKey");
    if (layerKeys.has(layerKey)) requiredString(layer.geometryType, `layer.${layerKey}.geometryType`);
  }
  const bounds = geometryBounds(geometries);
  return bounds === undefined ? undefined : { crs: "EPSG:4326", bbox: bounds };
}

function geometryBounds(geometries: JsonObject[]): number[] | undefined {
  const points: Array<[number, number]> = [];
  for (const geometry of geometries) collectPoints(geometry.coordinates, points);
  if (points.length === 0) return undefined;
  const longitudes = points.map(([longitude]) => longitude);
  const latitudes = points.map(([, latitude]) => latitude);
  return [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)];
}

function collectPoints(value: unknown, points: Array<[number, number]>): void {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    points.push([value[0], value[1]]);
    return;
  }
  for (const item of value) collectPoints(item, points);
}

function supportedCapabilities(dataKind: string): string[] {
  if (dataKind === "CURRENT_PROJECTION") {
    return ["spatial.find-in-area", "spatial.find-nearby", "world.get-current-state", "world.get-provenance"];
  }
  if (dataKind === "NETWORK") return ["catalog.get", "catalog.search"];
  return ["catalog.get", "catalog.search", "feature.get", "spatial.find-intersections"];
}

function scopeMap(spec: JsonObject): Map<string, string> {
  return new Map(requireRecordArray(spec.scopes, "world-spec.scopes").map((scope) => [
    requiredString(scope.dataScope, "scope.dataScope"),
    requiredString(scope.datasetScope, "scope.datasetScope")
  ]));
}

function requireDatasetScope(scopes: Map<string, string>, dataScope: string): string {
  return requireMapValue(scopes, dataScope, "dataset scope");
}

function requireCatalogReference(mapping: SampleWorldReferenceMapEntry): ReferenceKey {
  if (mapping.currentCatalogReferenceKey === undefined) {
    throw new Error(`No current catalog ReferenceKey for ${mapping.fixtureKey}`);
  }
  return mapping.currentCatalogReferenceKey;
}

function requireWorldReference(mapping: SampleWorldReferenceMapEntry): ReferenceKey {
  if (mapping.currentWorldReferenceKey === undefined) {
    throw new Error(`No current world ReferenceKey for ${mapping.fixtureKey}`);
  }
  return mapping.currentWorldReferenceKey;
}

function addReferenceEntry(
  entries: Map<string, SampleWorldReferenceMapEntry>,
  entry: SampleWorldReferenceMapEntry
): void {
  if (entries.has(entry.fixtureKey)) throw new Error(`Duplicate sample-world fixture key: ${entry.fixtureKey}`);
  entries.set(entry.fixtureKey, entry);
}

function requireMapValue<K, V>(map: Map<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing ${label}: ${String(key)}`);
  return value;
}

function requireFeatureCollection(value: unknown, label: string): JsonObject {
  const collection = requireObject(value, label);
  if (collection.type !== "FeatureCollection") throw new Error(`${label} is not a FeatureCollection`);
  requireRecordArray(collection.features, `${label}.features`);
  return collection;
}

function requireObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function requireRecordArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requireObject(item, `${label}[${index}]`));
}

function requireJsonArray(value: unknown, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value as JsonValue[];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  return value;
}

function requiredFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function sortStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value].sort(compareCanonicalText) as string[];
}

function sortRecords(values: JsonObject[], key: string): JsonObject[] {
  return [...values].sort((left, right) =>
    compareCanonicalText(requiredString(left[key], `${key}`), requiredString(right[key], `${key}`))
  );
}

function sortFeatures(values: JsonObject[]): JsonObject[] {
  return [...values].sort((left, right) => {
    const leftKey = requiredString(requireObject(left.properties, "feature.properties").fixtureFeatureKey, "fixtureFeatureKey");
    const rightKey = requiredString(requireObject(right.properties, "feature.properties").fixtureFeatureKey, "fixtureFeatureKey");
    return compareCanonicalText(leftKey, rightKey);
  });
}

function compact(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as JsonObject;
}

function normalizeEpoch(value: string): string {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new Error("Sample-world epoch must include an explicit UTC offset");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Sample-world epoch is not a valid date-time");
  return date.toISOString();
}

function normalizeSeed(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("Sample-world seed must not be empty");
  if (value.length > 1024) throw new Error("Sample-world seed is too long");
  return value;
}

function offsetTime(epoch: string, offsetMs: number): string {
  return new Date(new Date(epoch).getTime() + offsetMs).toISOString();
}

function uuidBytes(value: string): Buffer {
  const hex = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(hex)) throw new Error(`Invalid UUID namespace: ${value}`);
  return Buffer.from(hex, "hex");
}

function isWithin(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`) || normalizedTarget.startsWith(`${normalizedRoot}/`);
}
