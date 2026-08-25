import type { Pool } from "pg";

import {
  canonicalSha256,
  type GowmV06CoverageAlternative,
  type GowmV06CoverageExpandRequest,
  type GowmV06CoverageProblem,
  type GowmV06CoverageResultSet,
  type GowmV06CoverageRoute,
  type GowmV06CoverageVerificationReport,
  type GowmV06CoverageVerificationRequest,
  type GowmV06RoadCoverageRequest
} from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  ProviderProtocolError,
  type ProviderHandlerContext,
  type ProviderOperationResult
} from "../../../../packages/platform/provider-sdk/src/index.js";
import {
  buildCanonicalCoverageProblem,
  PostgresCoverageEndpointRepository,
  PostgresCoverageSelectionRepository,
  resolveCoverageEndpoints,
  selectRoadServiceObligations,
  solveStrictCoverageRoute,
  type CoverageRoutingObjective,
  type CoverageSqlPool,
  type CoverageTraversalArc,
  type CoverageTurnRule,
  type CoverageTravelPolicy,
  type GeoJsonArea
} from "../../../../packages/road-coverage-planning-core/src/index.js";
import { buildVerifiedCoverageResultSet, type VerifiedAlternativeCandidate } from "../../../../packages/road-coverage-alternatives-core/src/index.js";
import { admitVerifiedCoverageRoute, verifyCoverageRoute } from "../../../../packages/road-coverage-verifier-core/src/index.js";
import { PostgresCoverageAsyncRepository } from "../../../../packages/road-coverage-runtime-core/src/index.js";
import { NetworkRepository, type LoadedNetwork, type NetworkSqlPool } from "../../../../packages/network-query-core/src/index.js";
import type { RoadCoverageEngine } from "./engine.js";

type JsonObject = Record<string, unknown>;

export interface PostgresRoadCoverageEngineOptions {
  pool: Pick<Pool, "connect" | "query">;
  now?: () => Date;
  resultTtlMs?: number;
  leaseSeconds?: number;
  workerId?: string;
  observeStage?: (measurement: CoverageRuntimeStageMeasurement) => void;
}

export type CoverageRuntimeStage =
  | "OBLIGATION_SELECTION"
  | "ENDPOINT_RESOLUTION"
  | "CONNECTOR_MATRIX_SEARCH"
  | "SOLVER_TOTAL"
  | "INDEPENDENT_VERIFIER"
  | "RESULT_PERSIST"
  | "GEOJSON_EXPAND";

export interface CoverageRuntimeStageMeasurement {
  stage: CoverageRuntimeStage;
  elapsedMs: number;
  units: number;
}

export const ROAD_COVERAGE_RESOURCE_LIMITS = {
  maximumAreaVertices: 50_000,
  maximumObligations: 100_000,
  maximumMatrixCells: 100_000,
  maximumGenerationCandidates: 64,
  maximumRouteSegments: 1_000_000
} as const;

/**
 * The production road-coverage engine composes the versioned network read contract,
 * the isolated coverage-planner write contract, and the independent verifier. It
 * deliberately has no HTTP Provider client and therefore cannot create a second
 * routing or job authority.
 */
export class PostgresRoadCoverageEngine implements RoadCoverageEngine {
  readonly #now: () => Date;
  readonly #resultTtlMs: number;
  readonly #leaseSeconds: number;
  readonly #workerId: string;
  readonly #observeStage: (measurement: CoverageRuntimeStageMeasurement) => void;
  readonly #network: NetworkRepository;
  readonly #selection: PostgresCoverageSelectionRepository;
  readonly #endpoint: PostgresCoverageEndpointRepository;
  readonly #async: PostgresCoverageAsyncRepository;

  constructor(options: PostgresRoadCoverageEngineOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#resultTtlMs = positive(options.resultTtlMs ?? 300_000, "resultTtlMs");
    this.#leaseSeconds = positive(options.leaseSeconds ?? 300, "leaseSeconds");
    this.#workerId = options.workerId?.trim() || "road-coverage-provider";
    this.#observeStage = options.observeStage ?? (() => undefined);
    const pool = sqlPool(options.pool);
    this.#network = new NetworkRepository({ pool: pool as NetworkSqlPool, now: this.#now });
    this.#selection = new PostgresCoverageSelectionRepository({ pool });
    this.#endpoint = new PostgresCoverageEndpointRepository(pool);
    this.#async = new PostgresCoverageAsyncRepository(options.pool as Pick<Pool, "query">);
  }

  async validate(input: unknown, context: ProviderHandlerContext): Promise<ProviderOperationResult<unknown>> {
    const request = input as GowmV06RoadCoverageRequest;
    assertRequestResources(request);
    const scope = trustedScope(context);
    const network = await this.#network.loadPinned(request.routingSnapshot, scope, context.deadline.remainingMs());
    const violations: Array<{ code: string; message: string; path: string }> = [];
    if (request.selectionPolicy.mode !== "MANUAL_OBLIGATIONS" && !isArea(request.area)) {
      violations.push({ code: "AREA_NOT_RESOLVED", message: "area ReferenceKey must be resolved to Polygon or MultiPolygon before planning", path: "/area" });
    }
    if (request.endpointPolicy.endpointMode === "LAST_AREA_EXIT") {
      violations.push({ code: "CAPABILITY_NOT_AVAILABLE", message: "LAST_AREA_EXIT is not Stable in v0.6", path: "/endpointPolicy/endpointMode" });
    }
    return completed({
      schemaVersion: "1.0",
      valid: violations.length === 0,
      violations,
      warnings: [],
      normalizedSummary: {
        routeCount: 1,
        selectionMode: request.selectionPolicy.mode,
        serviceMode: request.selectionPolicy.serviceMode,
        endpointMode: request.endpointPolicy.endpointMode,
        requestedAlternativeCount: request.alternativePolicy.requestedCount,
        ...(request.selectionPolicy.mode === "MANUAL_OBLIGATIONS"
          ? { estimatedObligationCount: request.selectionPolicy.manualObligations?.length ?? 0 }
          : {})
      }
    }, network, 1, 0);
  }

  async selectObligations(input: unknown, context: ProviderHandlerContext): Promise<ProviderOperationResult<unknown>> {
    const request = input as GowmV06RoadCoverageRequest;
    assertRequestResources(request);
    const scope = trustedScope(context);
    const network = await this.#network.loadPinned(request.routingSnapshot, scope, context.deadline.remainingMs());
    const startedAt = performance.now();
    const selection = await this.#select(request, scope);
    this.#measure("OBLIGATION_SELECTION", startedAt, selection.obligationSet.obligationCount);
    return completed(selection.obligationSet, network, selection.receipt.candidateCount, selection.obligationSet.obligationCount);
  }

  async plan(input: unknown, context: ProviderHandlerContext): Promise<ProviderOperationResult<unknown>> {
    const request = input as GowmV06RoadCoverageRequest;
    assertRequestResources(request);
    const scope = trustedScope(context);
    const gatewayJobId = context.gateway?.gatewayJobId;
    const gatewayQueryId = context.gateway?.gatewayQueryId;
    const gatewayNodeId = context.gateway?.gatewayNodeId;
    if (!gatewayJobId || !gatewayQueryId || !gatewayNodeId) {
      throw new ProviderProtocolError("INVALID_REQUEST", "coverage.road.plan requires a trusted Gateway async job context");
    }
    const network = await this.#network.loadPinned(request.routingSnapshot, scope, context.deadline.remainingMs());
    const submission = await this.#async.submit({
      dataScopeKey: scope.dataScopeKey,
      datasetScopeKey: scope.datasetScopeKey,
      externalRequestId: request.requestId,
      idempotencyKey: `${gatewayQueryId}:${gatewayNodeId}:${request.requestId}`,
      gatewayJobId,
      requestHash: canonicalSha256(request),
      routingSnapshotHash: canonicalSha256(request.routingSnapshot),
      routingSnapshot: json(request.routingSnapshot),
      request: json(request)
    });
    if (["SUCCEEDED", "PARTIAL", "NO_FEASIBLE_PLAN"].includes(submission.status)) {
      const replay = await this.#async.getResult(submission.coverageRequestId, scope.dataScopeKey, scope.datasetScopeKey);
      if (replay === null) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "terminal coverage request has no immutable result");
      return completed(replay, network, network.arcs.length, alternatives(replay).length);
    }
    const leaseOwner = `${this.#workerId}:${gatewayNodeId}`.slice(0, 256);
    const claim = await this.#async.claim(submission.coverageRequestId, leaseOwner, this.#leaseSeconds);
    if (claim === null) throw new ProviderProtocolError("OVERLOADED", "coverage request is already leased", { retryable: true });
    await accepted(this.#async.heartbeat(claim, leaseOwner, this.#leaseSeconds, "SELECTING", 100_000, { graphArcCount: network.arcs.length }), "selection heartbeat");

    let startedAt = performance.now();
    const selection = await this.#select(request, scope);
    this.#measure("OBLIGATION_SELECTION", startedAt, selection.obligationSet.obligationCount);
    const area = resolvedArea(request.area);
    startedAt = performance.now();
    const endpoints = await resolveCoverageEndpoints(this.#endpoint, {
      dataScopeKey: scope.dataScopeKey,
      datasetScopeKey: scope.datasetScopeKey,
      routingSnapshot: request.routingSnapshot,
      area,
      policy: request.endpointPolicy
    });
    this.#measure("ENDPOINT_RESOLUTION", startedAt, endpoints.entryStates.length + endpoints.exitStates.length);
    const problem = buildCanonicalCoverageProblem({
      routingSnapshot: request.routingSnapshot,
      startState: endpoints.startState,
      ...(endpoints.fixedEndState === undefined ? {} : { fixedEndState: endpoints.fixedEndState }),
      entryStates: endpoints.entryStates,
      exitStates: endpoints.exitStates,
      endpointMode: endpoints.endpointMode,
      boundaryCrossingPolicy: endpoints.boundaryCrossingPolicy,
      obligationSet: selection.obligationSet,
      objective: request.objective,
      budgets: {
        timeLimitMs: Math.min(request.timeLimitMs, Math.max(100, context.deadline.remainingMs())),
        maximumCandidates: request.alternativePolicy.maximumGenerationCandidates ?? ROAD_COVERAGE_RESOURCE_LIMITS.maximumGenerationCandidates,
        maximumMatrixCells: ROAD_COVERAGE_RESOURCE_LIMITS.maximumMatrixCells
      }
    });
    await this.#async.persistProblem(claim, leaseOwner, digest(problem.problemHash), json(problem));
    await accepted(this.#async.heartbeat(claim, leaseOwner, this.#leaseSeconds, "SOLVING", 300_000, { obligationCount: selection.obligationSet.obligationCount }), "solver heartbeat");

    const networkArcs = traversalArcs(network);
    const turnRules = coverageTurnRules(network);
    const travelPolicy: CoverageTravelPolicy = { profileKey: request.routingSnapshot.travelProfileVersion, requiredAccessMask: 0 };
    const candidates: VerifiedAlternativeCandidate[] = [];
    for (const profile of request.alternativePolicy.profiles) {
      startedAt = performance.now();
      const solved = solveStrictCoverageRoute(problem, networkArcs, {
        objective: objective(profile),
        travelPolicy,
        turnRules,
        routeCount: 1,
        serviceMode: request.selectionPolicy.serviceMode,
        seed: candidates.length
      });
      const solverElapsedMs = performance.now() - startedAt;
      this.#observeStage({
        stage: "CONNECTOR_MATRIX_SEARCH",
        elapsedMs: solved.diagnostics.elapsedMs,
        units: metric(solved.diagnostics.resourceMetrics?.matrixCellCount)
      });
      this.#observeStage({ stage: "SOLVER_TOTAL", elapsedMs: solverElapsedMs, units: solved.diagnostics.candidatesGenerated });
      startedAt = performance.now();
      const verification = verifyCoverageRoute({
        problem,
        candidate: solved.route,
        currentRoutingSnapshot: network.routingSnapshot,
        networkArcs,
        objective: objective(profile),
        travelPolicy,
        turnRules
      });
      this.#measure("INDEPENDENT_VERIFIER", startedAt, solved.route.segments.length);
      const admitted = admitVerifiedCoverageRoute(solved.route, verification);
      startedAt = performance.now();
      await this.#async.persistCandidate(claim, leaseOwner, {
        problemHash: digest(problem.problemHash),
        objectiveProfile: profile,
        candidateHash: digest(solved.route.routeSignature),
        route: json(solved.route),
        solverDiagnostics: json({ ...solved.diagnostics, candidatesVerified: 1 }),
        verification: json(verification)
      });
      this.#measure("RESULT_PERSIST", startedAt, solved.route.segments.length);
      candidates.push({ admitted, objectiveProfile: profile, solverDiagnostics: { ...solved.diagnostics, candidatesVerified: 1 } });
    }
    await accepted(this.#async.heartbeat(claim, leaseOwner, this.#leaseSeconds, "VERIFYING", 800_000, { admittedCandidateCount: candidates.length }), "verification heartbeat");
    const createdAt = this.#now();
    const result = buildVerifiedCoverageResultSet({
      requestId: request.requestId,
      problemHash: digest(problem.problemHash),
      routingSnapshot: request.routingSnapshot,
      policy: request.alternativePolicy,
      candidates,
      searchTerminatedBy: "PROFILES_COMPLETE",
      createdAt: createdAt.toISOString(),
      validUntil: new Date(createdAt.getTime() + this.#resultTtlMs).toISOString()
    });
    await accepted(this.#async.heartbeat(claim, leaseOwner, this.#leaseSeconds, "PUBLISHING", 950_000, { selectedAlternativeCount: result.alternatives.length }), "publication heartbeat");
    startedAt = performance.now();
    await accepted(this.#async.publishResult(claim, leaseOwner, {
      referenceKey: result.referenceKey.id,
      status: result.status as "SUCCEEDED" | "PARTIAL" | "NO_FEASIBLE_PLAN",
      resultHash: digest(result.resultHash),
      validUntil: result.validUntil,
      result: json(result)
    }), "result publication");
    this.#measure("RESULT_PERSIST", startedAt, result.alternatives.length);
    return completed(result, network, network.arcs.length, result.alternatives.length);
  }

  async verify(input: unknown, context: ProviderHandlerContext): Promise<ProviderOperationResult<unknown>> {
    const request = input as GowmV06CoverageVerificationRequest;
    const scope = trustedScope(context);
    const referenceKey = typeof request.problemReference === "string" ? request.problemReference : request.problemReference.id;
    const artifact = await this.#async.getArtifact(referenceKey, scope.dataScopeKey, scope.datasetScopeKey);
    if (artifact === null) throw new ProviderProtocolError("VERSION_NOT_FOUND", "coverage result/problem artifact is unavailable in scope");
    const problem = artifact.problem as GowmV06CoverageProblem;
    const network = await this.#network.loadPinned(request.routingSnapshot, scope, context.deadline.remainingMs());
    const profile = request.candidate.objectiveProfile;
    const travelPolicy: CoverageTravelPolicy = { profileKey: request.routingSnapshot.travelProfileVersion, requiredAccessMask: 0 };
    let report = verifyCoverageRoute({
      problem,
      candidate: request.candidate.route,
      currentRoutingSnapshot: network.routingSnapshot,
      networkArcs: traversalArcs(network),
      objective: objective(profile),
      travelPolicy,
      turnRules: coverageTurnRules(network)
    });
    if (artifact.expired === true && report.status === "VALID") report = expiredReport(report);
    return completed(report, network, network.arcs.length, 1);
  }

  async expandGeoJson(input: unknown, context: ProviderHandlerContext): Promise<ProviderOperationResult<unknown>> {
    const request = input as GowmV06CoverageExpandRequest;
    const scope = trustedScope(context);
    const startedAt = performance.now();
    const artifact = await this.#async.getArtifact(request.resultSetReferenceKey.id, scope.dataScopeKey, scope.datasetScopeKey);
    if (artifact === null) throw new ProviderProtocolError("VERSION_NOT_FOUND", "coverage result artifact is unavailable in scope");
    const result = artifact.result as GowmV06CoverageResultSet;
    const network = await this.#network.loadPinned(result.routingSnapshot, scope, context.deadline.remainingMs());
    const value = await this.#async.expandGeoJson(request.resultSetReferenceKey.id, request.alternativeId, scope.dataScopeKey, scope.datasetScopeKey);
    this.#measure("GEOJSON_EXPAND", startedAt, Array.isArray(value.features) ? value.features.length : 0);
    return completed(value, network, Array.isArray(value.features) ? value.features.length : 0, 1);
  }

  async #select(request: GowmV06RoadCoverageRequest, scope: Scope) {
    return await selectRoadServiceObligations(this.#selection, {
      dataScopeKey: scope.dataScopeKey,
      datasetScopeKey: scope.datasetScopeKey,
      routingSnapshot: request.routingSnapshot,
      area: request.area,
      policy: request.selectionPolicy,
      maximumSelectionCandidates: 100_000
    });
  }

  #measure(stage: CoverageRuntimeStage, startedAt: number, units: number): void {
    this.#observeStage({ stage, elapsedMs: Math.max(0, performance.now() - startedAt), units });
  }
}

interface Scope { dataScopeKey: string; datasetScopeKey: string }

function trustedScope(context: ProviderHandlerContext): Scope {
  const dataScopeKey = context.security.dataScopeClaim?.trim();
  const datasetScopeKey = context.security.datasetScopeClaims?.[0]?.trim();
  if (!dataScopeKey || !datasetScopeKey) throw new ProviderProtocolError("SCOPE_REQUIRED", "coverage data and dataset scopes are required");
  return { dataScopeKey, datasetScopeKey };
}

function sqlPool(pool: Pick<Pool, "connect">): CoverageSqlPool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query<T extends JsonObject = JsonObject>(text: string, values?: readonly unknown[]) {
          const result = await client.query(text, values === undefined ? undefined : [...values]);
          return { rows: result.rows as T[], rowCount: result.rowCount };
        },
        release: () => client.release()
      };
    }
  };
}

function traversalArcs(network: LoadedNetwork): CoverageTraversalArc[] {
  return network.arcs.map((arc) => ({
    graphVersion: network.routingSnapshot.graphVersion,
    arcKey: arc.key,
    fromNodeKey: arc.source,
    toNodeKey: arc.target,
    direction: arc.direction,
    metrics: {
      distanceMm: arc.distanceMm,
      durationMs: arc.durationMs,
      riskMicroUnits: arc.riskMicroUnits,
      energyMwh: arc.energyMwh,
      combinedCostUnits: arc.combinedCostUnits,
      turnPenaltyUnits: 0
    },
    ...(arc.sourceFeatureReferenceKey === undefined ? {} : { sourceFeatureReferenceKey: arc.sourceFeatureReferenceKey as never }),
    traversalAllowed: true,
    conditionPenaltyUnits: arc.conditionPenaltyUnits
  }));
}

function coverageTurnRules(network: LoadedNetwork): CoverageTurnRule[] {
  return network.turnRules.map((rule, index) => ({
    ruleKey: `turn_${index + 1}`,
    arcSequence: rule.sequence,
    ruleType: rule.ruleType,
    ...(rule.penaltyUnits === 0 ? {} : { penaltyUnits: rule.penaltyUnits })
  }));
}

function objective(profile: GowmV06CoverageAlternative["objectiveProfile"]): CoverageRoutingObjective {
  if (profile === "FASTEST_COMPLETION") return "FASTEST";
  if (profile === "SHORTEST_TOTAL_DISTANCE" || profile === "LEAST_DEADHEAD") return "SHORTEST_DISTANCE";
  if (profile === "LOWEST_RISK") return "LOWEST_RISK";
  return "BALANCED";
}

function resolvedArea(area: GowmV06RoadCoverageRequest["area"]): GeoJsonArea {
  if (!isArea(area)) throw new ProviderProtocolError("INVALID_REQUEST", "coverage area must be resolved before endpoint planning");
  return area;
}

function isArea(value: GowmV06RoadCoverageRequest["area"]): value is GeoJsonArea {
  return "type" in value && (value.type === "Polygon" || value.type === "MultiPolygon");
}

function assertRequestResources(request: GowmV06RoadCoverageRequest): void {
  if (isArea(request.area)) {
    const vertices = coordinateCount(request.area.coordinates);
    if (vertices > ROAD_COVERAGE_RESOURCE_LIMITS.maximumAreaVertices) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "coverage area exceeds the registered vertex limit", {
        details: { metric: "vertices", consumed: vertices, limit: ROAD_COVERAGE_RESOURCE_LIMITS.maximumAreaVertices }
      });
    }
  }
  const obligations = request.selectionPolicy.manualObligations?.length ?? 0;
  if (obligations > ROAD_COVERAGE_RESOURCE_LIMITS.maximumObligations) {
    throw new ProviderProtocolError("BUDGET_EXCEEDED", "manual obligations exceed the registered limit");
  }
  const candidates = request.alternativePolicy.maximumGenerationCandidates ?? ROAD_COVERAGE_RESOURCE_LIMITS.maximumGenerationCandidates;
  if (candidates > ROAD_COVERAGE_RESOURCE_LIMITS.maximumGenerationCandidates) {
    throw new ProviderProtocolError("BUDGET_EXCEEDED", "alternative candidate budget exceeds the registered limit");
  }
}

function coordinateCount(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  if (value.length >= 2 && value.every((item) => typeof item === "number")) return 1;
  let count = 0;
  for (const item of value) {
    count += coordinateCount(item);
    if (count > ROAD_COVERAGE_RESOURCE_LIMITS.maximumAreaVertices) return count;
  }
  return count;
}

function completed(value: unknown, network: LoadedNetwork, rows: number, candidates: number): ProviderOperationResult<unknown> {
  return { status: "COMPLETED", value, dataSnapshot: network.dataSnapshot, consumption: { rows, candidates } };
}

function alternatives(value: JsonObject): unknown[] { return Array.isArray(value.alternatives) ? value.alternatives : []; }
function json(value: unknown): JsonObject { return value as JsonObject; }
function digest(value: string): `sha256:${string}` { return value as `sha256:${string}`; }
function positive(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`); return value; }
function metric(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
async function accepted(value: Promise<boolean>, stage: string): Promise<void> { if (!await value) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${stage} was rejected by the coverage authority`); }

function expiredReport(report: GowmV06CoverageVerificationReport): GowmV06CoverageVerificationReport {
  const body = {
    ...report,
    status: "STALE" as const,
    checks: { ...report.checks, resultTtl: false },
    violations: [...report.violations, { code: "RESULT_EXPIRED", message: "coverage result validUntil has elapsed" }]
  };
  const { reportHash: _oldHash, verificationId: _oldId, ...identityBody } = body;
  const identityHash = canonicalSha256(identityBody);
  const verificationId = `verify_${identityHash.slice("sha256:".length)}`;
  const { reportHash: _unused, ...withoutHash } = body;
  return { ...withoutHash, verificationId, reportHash: canonicalSha256({ ...withoutHash, verificationId }) };
}
