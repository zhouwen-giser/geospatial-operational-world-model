import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { realizeSampleWorld, type SampleWorldRealization } from "./model.js";
import type { SampleRuntimeEnvironment } from "./runtime.js";

type AnyRecord = Record<string, any>;

export async function loadRuntimeSampleWorld(runtime: SampleRuntimeEnvironment): Promise<SampleWorldRealization> {
  const source = await realizeSampleWorld({
    epoch: runtime.values.SAMPLE_WORLD_EPOCH!,
    seed: runtime.values.SAMPLE_WORLD_SEED!
  });
  const loaded = JSON.parse(await readFile(
    resolve(runtime.paths.outputDirectory, "SAMPLE_REFERENCE_MAP.json"),
    "utf8"
  )) as AnyRecord;
  if (loaded.fixtureId !== source.fixture.id || loaded.fixtureVersion !== source.fixture.version ||
      loaded.realizationId !== source.fixture.realizationId || !Array.isArray(loaded.entries)) {
    throw new Error("Loaded sample reference map does not match the generated realization");
  }
  const byId = new Map<string, AnyRecord>();
  for (const entry of loaded.entries as AnyRecord[]) {
    const id = entry.identityReferenceKey?.id;
    if (typeof id !== "string") throw new Error(`Loaded reference-map entry has no identity id: ${String(entry.fixtureKey)}`);
    byId.set(id, entry);
  }
  const expectedCases = rebindReferenceKeys(source.expectedCases, byId) as SampleWorldRealization["expectedCases"];
  return {
    ...source,
    referenceMap: loaded as SampleWorldRealization["referenceMap"],
    expectedCases
  };
}

export function rebindReferenceKeys(value: unknown, byId: Map<string, AnyRecord>): unknown {
  if (Array.isArray(value)) return value.map((item) => rebindReferenceKeys(item, byId));
  if (!value || typeof value !== "object") return value;
  const record = value as AnyRecord;
  if (record.namespace === "gowm" && typeof record.id === "string" &&
      typeof record.kind === "string" && typeof record.version === "string") {
    const entry = byId.get(record.id);
    if (!entry) throw new Error(`Expected case references an identity absent from the loaded map: ${record.id}`);
    const actual = record.kind === "WORLD_OBJECT"
      ? entry.currentWorldReferenceKey ?? entry.identityReferenceKey
      : ["DATASET", "LAYER", "LAYER_FEATURE"].includes(record.kind)
        ? entry.currentCatalogReferenceKey ?? entry.identityReferenceKey
        : entry.identityReferenceKey;
    return { ...actual };
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, rebindReferenceKeys(item, byId)]));
}
