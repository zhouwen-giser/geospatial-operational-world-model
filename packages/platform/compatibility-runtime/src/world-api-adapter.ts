import type { CapabilityResultEnvelope } from "../../contract-runtime/src/index.js";
import { canonicalSha256 } from "../../contract-runtime/src/index.js";
import type {
  ControlledCompatibilityOperation,
  GatewayOperationClient,
  GatewayTransportContext
} from "./gateway-client.js";

export type CompatibilityMode = "LEGACY" | "DUAL_RUN" | "GATEWAY";

export type SpatialCompatibilityRoute =
  | "spatial.nearby"
  | "spatial.nearest"
  | "spatial.in-area"
  | "spatial.intersections"
  | "spatial.near-route"
  | "spatial.objects-along-route"
  | "spatial.area-summary";

export type SituationCompatibilityRoute =
  | "situation.get-cell"
  | "situation.get-area"
  | "situation.get-hotspots"
  | "situation.get-coverage-gaps";

export type CompatibilityRoute = SpatialCompatibilityRoute | SituationCompatibilityRoute;

export interface CompatibilityParityAttestation {
  schemaVersion: "1.0";
  route: CompatibilityRoute;
  operationId: ControlledCompatibilityOperation;
  verifiedAt: string;
  fixtureSetHash: `sha256:${string}`;
  comparisonCount: number;
  mismatchCount: 0;
}

export interface CompatibilityParityEvidence {
  schemaVersion: "1.0";
  route: CompatibilityRoute;
  operationId: ControlledCompatibilityOperation;
  status: "MATCH" | "MISMATCH" | "GATEWAY_ERROR" | "CUTOVER_BLOCKED" | "UNSUPPORTED";
  comparedAt: string;
  legacyResultHash?: `sha256:${string}`;
  gatewayResultHash?: `sha256:${string}`;
  adaptedGatewayResultHash?: `sha256:${string}`;
  legacySemanticHash?: `sha256:${string}`;
  gatewaySemanticHash?: `sha256:${string}`;
  detail?: string;
}

export interface WorldApiCompatibilityAdapterOptions {
  mode?: CompatibilityMode;
  gateway: GatewayOperationClient;
  attestations?: readonly CompatibilityParityAttestation[];
  now?: () => Date;
  onEvidence?: (evidence: CompatibilityParityEvidence) => void;
}

interface RouteSpec {
  operationId: ControlledCompatibilityOperation;
  gatewayInput(input: unknown): unknown;
  adaptGateway(envelope: CapabilityResultEnvelope, input: unknown): unknown;
}

const ROUTE_SPECS: Readonly<Record<CompatibilityRoute, RouteSpec>> = {
  "spatial.nearby": spatialObjectSpec("spatial.find-nearby", nearbyInput, "nearby"),
  "spatial.nearest": spatialObjectSpec("spatial.find-nearest", nearestInput, "nearest"),
  "spatial.in-area": spatialObjectSpec("spatial.find-in-area", areaInput, "in-area"),
  "spatial.intersections": spatialObjectSpec("spatial.find-intersections", intersectionsInput, "intersections"),
  "spatial.near-route": spatialObjectSpec("spatial.find-near-route", routeInput, "near-route"),
  "spatial.objects-along-route": spatialObjectSpec("spatial.find-near-route", routeInput, "near-route"),
  "spatial.area-summary": {
    operationId: "spatial.summarize-area",
    gatewayInput: summarizeInput,
    adaptGateway: (envelope) => adaptAreaSummary(envelope)
  },
  "situation.get-cell": {
    operationId: "gowm.situation.h3.get-cell",
    gatewayInput: (input) => ({ h3Index: requiredString(asRecord(input).h3Index, "h3Index") }),
    adaptGateway: (envelope) => {
      const output = outputRecord(envelope);
      return array(output.cells)[0];
    }
  },
  "situation.get-area": {
    operationId: "gowm.situation.h3.get-area",
    gatewayInput: (input) => {
      const value = asRecord(input);
      return { area: value.area, resolution: value.resolution };
    },
    adaptGateway: (envelope) => {
      const output = outputRecord(envelope);
      const summary = asRecord(output.summary);
      return legacyEnvelope(summary, array(output.cells), output.worldVersion, envelope.execution.elapsedMs);
    }
  },
  "situation.get-hotspots": {
    operationId: "gowm.situation.h3.get-hotspots",
    gatewayInput: rankedSituationInput,
    adaptGateway: (envelope) => adaptRankedSituation(envelope)
  },
  "situation.get-coverage-gaps": {
    operationId: "gowm.situation.h3.get-coverage-gaps",
    gatewayInput: coverageGapsInput,
    adaptGateway: (envelope) => adaptRankedSituation(envelope)
  }
};

export class WorldApiCompatibilityAdapter {
  readonly mode: CompatibilityMode;
  private readonly gateway: GatewayOperationClient;
  private readonly attestations: ReadonlyMap<CompatibilityRoute, CompatibilityParityAttestation>;
  private readonly now: () => Date;
  private readonly onEvidence: (evidence: CompatibilityParityEvidence) => void;

  constructor(options: WorldApiCompatibilityAdapterOptions) {
    this.mode = options.mode ?? "LEGACY";
    this.gateway = options.gateway;
    this.now = options.now ?? (() => new Date());
    this.onEvidence = options.onEvidence ?? (() => undefined);
    this.attestations = new Map((options.attestations ?? []).map((attestation) => {
      assertAttestation(attestation);
      return [attestation.route, attestation];
    }));
  }

  execute<T>(
    route: CompatibilityRoute,
    input: unknown,
    legacy: () => Promise<T>,
    context: GatewayTransportContext = {}
  ): Promise<T> {
    if (this.mode === "LEGACY") return legacy();
    const spec = ROUTE_SPECS[route];
    let gatewayInput: unknown;
    try {
      gatewayInput = spec.gatewayInput(input);
    } catch (error) {
      this.record(route, spec.operationId, "UNSUPPORTED", { detail: message(error) });
      return legacy();
    }
    if (this.mode === "GATEWAY") {
      const attestation = this.attestations.get(route);
      if (!attestation || attestation.operationId !== spec.operationId) {
        this.record(route, spec.operationId, "CUTOVER_BLOCKED", { detail: "verified parity attestation is absent" });
        return legacy();
      }
      return this.gateway.execute(spec.operationId, gatewayInput, context)
        .then((envelope) => spec.adaptGateway(envelope, input) as T);
    }
    return this.dualRun(route, input, gatewayInput, legacy, context, spec);
  }

  private async dualRun<T>(
    route: CompatibilityRoute,
    input: unknown,
    gatewayInput: unknown,
    legacy: () => Promise<T>,
    context: GatewayTransportContext,
    spec: RouteSpec
  ): Promise<T> {
    const [legacyResult, gatewayResult] = await Promise.allSettled([
      legacy(),
      this.gateway.execute(spec.operationId, gatewayInput, context)
    ]);
    if (legacyResult.status === "rejected") throw legacyResult.reason;
    if (gatewayResult.status === "rejected") {
      this.record(route, spec.operationId, "GATEWAY_ERROR", { detail: message(gatewayResult.reason) });
      return legacyResult.value;
    }
    const adapted = spec.adaptGateway(gatewayResult.value, input);
    const legacyMaterial = resultMaterial(legacyResult.value);
    const gatewayMaterial = resultMaterial(adapted);
    const legacyResultHash = canonicalSha256(legacyMaterial);
    const adaptedGatewayResultHash = canonicalSha256(gatewayMaterial);
    const legacySemanticHash = canonicalSha256(semanticProjection(legacyMaterial));
    const gatewaySemanticHash = canonicalSha256(semanticProjection(gatewayMaterial));
    const exact = legacyResultHash === adaptedGatewayResultHash;
    const semantic = legacySemanticHash === gatewaySemanticHash;
    this.record(route, spec.operationId, exact && semantic ? "MATCH" : "MISMATCH", {
      legacyResultHash,
      ...(gatewayResult.value.execution.resultHash === undefined
        ? {}
        : { gatewayResultHash: gatewayResult.value.execution.resultHash as `sha256:${string}` }),
      adaptedGatewayResultHash,
      legacySemanticHash,
      gatewaySemanticHash,
      ...(!exact || !semantic ? { detail: `resultHashEqual=${exact};semanticEqual=${semantic}` } : {})
    });
    return legacyResult.value;
  }

  private record(
    route: CompatibilityRoute,
    operationId: ControlledCompatibilityOperation,
    status: CompatibilityParityEvidence["status"],
    detail: Omit<CompatibilityParityEvidence, "schemaVersion" | "route" | "operationId" | "status" | "comparedAt">
  ): void {
    this.onEvidence({
      schemaVersion: "1.0",
      route,
      operationId,
      status,
      comparedAt: this.now().toISOString(),
      ...detail
    });
  }
}

export function parseCompatibilityMode(value: string | undefined): CompatibilityMode {
  const normalized = (value ?? "LEGACY").toUpperCase();
  if (normalized !== "LEGACY" && normalized !== "DUAL_RUN" && normalized !== "GATEWAY") {
    throw new Error("WORLD_API_COMPATIBILITY_MODE must be LEGACY, DUAL_RUN or GATEWAY");
  }
  return normalized;
}

export function parseParityAttestations(value: string | undefined): CompatibilityParityAttestation[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("WORLD_API_PARITY_ATTESTATIONS_JSON must be an array");
  return parsed.map((candidate) => {
    assertAttestation(candidate);
    return candidate;
  });
}

function spatialObjectSpec(
  operationId: ControlledCompatibilityOperation,
  gatewayInput: (input: unknown) => unknown,
  summaryKind: "nearby" | "nearest" | "in-area" | "intersections" | "near-route"
): RouteSpec {
  return {
    operationId,
    gatewayInput,
    adaptGateway: (envelope, input) => adaptSpatialObjectPage(envelope, input, summaryKind)
  };
}

function nearbyInput(input: unknown): unknown {
  const value = asRecord(input);
  assertEmptyFilter(value.filter);
  const location = asRecord(value.location);
  return commonSpatial({
    location: { longitude: location.lon, latitude: location.lat },
    radiusM: value.radiusM
  }, value);
}

function nearestInput(input: unknown): unknown {
  const value = asRecord(input);
  assertEmptyFilter(value.filter);
  const location = asRecord(value.location);
  return commonSpatial({ location: { longitude: location.lon, latitude: location.lat } }, value);
}

function areaInput(input: unknown): unknown {
  const value = asRecord(input);
  assertEmptyFilter(value.filter);
  return commonSpatial({ geometry: value.area }, value);
}

function intersectionsInput(input: unknown): unknown {
  const value = asRecord(input);
  return commonSpatial({ geometry: value.geometry }, value);
}

function routeInput(input: unknown): unknown {
  const value = asRecord(input);
  if (typeof value.bufferM !== "number" || value.bufferM <= 0) throw new Error("zero-width legacy routes have no Gateway equivalent");
  return commonSpatial({ route: value.route, distanceM: value.bufferM }, value);
}

function summarizeInput(input: unknown): unknown {
  const value = asRecord(input);
  return { geometry: value.area, groupBy: "objectType", crs: "EPSG:4326" };
}

function commonSpatial(seed: Record<string, unknown>, legacy: Record<string, unknown>): Record<string, unknown> {
  const limit = legacy.limit === undefined ? undefined : Number(legacy.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1_000)) {
    throw new Error("legacy limit is outside the Gateway capability limit");
  }
  return {
    ...seed,
    ...(Array.isArray(legacy.objectTypes) ? { objectTypes: legacy.objectTypes } : {}),
    ...(limit === undefined ? {} : { limit }),
    includeGeometry: true,
    crs: "EPSG:4326"
  };
}

function rankedSituationInput(input: unknown): unknown {
  const value = asRecord(input);
  return {
    resolution: value.resolution,
    ...(value.metric === undefined ? {} : { metric: value.metric }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.parentCell === undefined ? {} : { parentCell: value.parentCell })
  };
}

function coverageGapsInput(input: unknown): unknown {
  const value = asRecord(input);
  return {
    resolution: value.resolution,
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(value.parentCell === undefined ? {} : { parentCell: value.parentCell })
  };
}

function adaptSpatialObjectPage(
  envelope: CapabilityResultEnvelope,
  input: unknown,
  summaryKind: "nearby" | "nearest" | "in-area" | "intersections" | "near-route"
): unknown {
  const output = outputRecord(envelope);
  const objects = array(output.objects).map(providerObjectToLegacy);
  const value = asRecord(input);
  const facts = summaryKind === "nearby" || summaryKind === "nearest" || summaryKind === "near-route"
    ? array(output.objects).map((object, index) => ({ object: objects[index], ...distance(object) }))
    : objects;
  const summary = summaryKind === "nearby"
    ? { count: facts.length, nearestDistanceM: firstDistance(output.objects), radiusM: value.radiusM }
    : summaryKind === "nearest" || summaryKind === "near-route"
      ? { count: facts.length, nearestDistanceM: firstDistance(output.objects) }
      : summaryKind === "in-area"
        ? { count: facts.length, byType: countBy(objects.map((object) => String(asRecord(object).type))) }
        : { count: facts.length };
  return legacyEnvelope(summary, facts, maximumVersion(output.objects), envelope.execution.elapsedMs, maximumFreshness(output.objects));
}

function adaptAreaSummary(envelope: CapabilityResultEnvelope): unknown {
  const output = outputRecord(envelope);
  const groups = array(output.groups);
  const byType = Object.fromEntries(groups.map((group) => {
    const record = asRecord(group);
    return [String(record.key), Number(record.count)];
  }));
  const total = Number(output.total ?? Object.values(byType).reduce((sum, count) => sum + count, 0));
  return legacyEnvelope({ total, byType }, byType, dataSnapshotVersion(envelope), envelope.execution.elapsedMs);
}

function adaptRankedSituation(envelope: CapabilityResultEnvelope): unknown {
  const output = outputRecord(envelope);
  const cells = array(output.cells);
  return legacyEnvelope(
    { count: cells.length, metric: output.metric, resolution: output.resolution },
    cells,
    Number(output.worldVersion ?? 0),
    envelope.execution.elapsedMs
  );
}

function providerObjectToLegacy(value: unknown): Record<string, unknown> {
  const object = asRecord(value);
  const referenceKey = asRecord(object.referenceKey);
  return {
    id: referenceKey.id,
    type: object.objectType,
    ...(typeof object.subtype === "string" ? { subtype: object.subtype } : {}),
    ...(isRecord(object.geometry) ? { geometry: object.geometry } : {}),
    state: { status: object.status },
    properties: isRecord(object.properties) ? object.properties : {},
    confidence: typeof object.confidence === "number" ? object.confidence : 0,
    ...(typeof object.observedAt === "string" ? { observedAt: object.observedAt } : {}),
    updatedAt: object.updatedAt,
    version: object.worldVersion,
    ...(typeof object.freshnessMs === "number" ? { freshnessMs: object.freshnessMs } : {})
  };
}

function legacyEnvelope(
  summary: Record<string, unknown>,
  facts: unknown,
  worldVersion: unknown,
  queryTimeMs: number,
  dataFreshnessMs: number | null = null
): Record<string, unknown> {
  return {
    summary,
    facts,
    context: {
      worldVersion: typeof worldVersion === "number" ? worldVersion : 0,
      dataFreshnessMs,
      queryTimeMs
    }
  };
}

function resultMaterial(value: unknown): unknown {
  if (isRecord(value) && Object.hasOwn(value, "facts")) return value.facts;
  return value ?? null;
}

function semanticProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticProjection);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["freshnessMs", "stale", "queryTimeMs", "dataFreshnessMs"].includes(key))
    .map(([key, child]) => [key, semanticProjection(child)]));
}

function outputRecord(envelope: CapabilityResultEnvelope): Record<string, unknown> {
  if (!envelope.output) throw new Error("Gateway result has no output");
  return asRecord(envelope.output.value);
}

function distance(value: unknown): Record<string, unknown> {
  const object = asRecord(value);
  return typeof object.distanceM === "number" ? { distanceM: object.distanceM } : {};
}

function firstDistance(values: unknown): number | null {
  const first = array(values)[0];
  const value = first ? asRecord(first).distanceM : undefined;
  return typeof value === "number" ? value : null;
}

function maximumVersion(values: unknown): number {
  return array(values).reduce<number>((maximum, value) => {
    const version = Number(asRecord(value).worldVersion ?? 0);
    return Number.isFinite(version) ? Math.max(maximum, version) : maximum;
  }, 0);
}

function maximumFreshness(values: unknown): number | null {
  const freshness = array(values)
    .map((value) => asRecord(value).freshnessMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return freshness.length ? Math.max(...freshness) : null;
}

function dataSnapshotVersion(envelope: CapabilityResultEnvelope): number {
  const versions = envelope.dataSnapshot?.resources.map((resource) => Number(resource.referenceKey.version)) ?? [];
  return versions.filter(Number.isFinite).reduce((maximum, value) => Math.max(maximum, value), 0);
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function assertEmptyFilter(value: unknown): void {
  if (isRecord(value) && Object.keys(value).length > 0) {
    throw new Error("legacy arbitrary filter has no locked Gateway capability equivalent");
  }
}

function assertAttestation(value: unknown): asserts value is CompatibilityParityAttestation {
  if (!isRecord(value) || value.schemaVersion !== "1.0" || !isRoute(value.route) ||
      typeof value.operationId !== "string" || ROUTE_SPECS[value.route].operationId !== value.operationId ||
      typeof value.verifiedAt !== "string" || !Number.isFinite(Date.parse(value.verifiedAt)) ||
      typeof value.fixtureSetHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.fixtureSetHash) ||
      !Number.isSafeInteger(value.comparisonCount) || Number(value.comparisonCount) < 1 || value.mismatchCount !== 0) {
    throw new Error("invalid compatibility parity attestation");
  }
}

function isRoute(value: unknown): value is CompatibilityRoute {
  return typeof value === "string" && Object.hasOwn(ROUTE_SPECS, value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("compatibility value must be an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("compatibility value must be an array");
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
