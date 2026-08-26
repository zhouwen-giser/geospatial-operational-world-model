import type { Pool } from "pg";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  canonicalSha256,
  getContractSchemaHash,
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
  CoveragePlanningError,
  PostgresCoverageEndpointRepository,
  PostgresCoverageSelectionRepository,
  resolveCoverageEndpoints,
  selectRoadServiceObligations,
  solveStrictCoverageRoute,
  type CoverageRoutingObjective,
  type CoverageObjectiveWeights,
  type CoverageSqlPool,
  type CoverageTraversalArc,
  type CoverageTurnRule,
  type CoverageTravelPolicy,
  type GeoJsonArea
} from "../../../../packages/road-coverage-planning-core/src/index.js";
import { buildVerifiedCoverageResultSet, type VerifiedAlternativeCandidate } from "../../../../packages/road-coverage-alternatives-core/src/index.js";
import { admitVerifiedCoverageRoute, verifyCoverageRoute } from "../../../../packages/road-coverage-verifier-core/src/index.js";
import { PostgresCoverageAsyncRepository } from "../../../../packages/road-coverage-runtime-core/src/index.js";
import { NetworkRepository, type BoundaryCrossing, type LoadedNetwork, type NetworkSqlPool, type RoutingSnapshotCurrentnessResult } from "../../../../packages/network-query-core/src/index.js";
import type { RoadCoverageEngine } from "./engine.js";

type JsonObject = Record<string, unknown>;
type CoverageObjectiveProfile = GowmV06RoadCoverageRequest["objective"]["profile"];

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
    const noFeasibleReasons = new Set<string>();
    const profiles = generationProfiles(request);
    for (const profile of profiles) {
      startedAt = performance.now();
      let solved;
      try {
        solved = solveStrictCoverageRoute(problem, networkArcs, {
          objective: objective(profile),
          ...(profile === "WEIGHTED" ? { objectiveWeights: objectiveWeights(request) } : {}),
          travelPolicy,
          turnRules,
          routeCount: 1,
          serviceMode: request.selectionPolicy.serviceMode,
          seed: candidates.length
        });
      } catch (error) {
        const reason = noFeasibleReason(error);
        if (reason === undefined) throw error;
        noFeasibleReasons.add(reason);
        continue;
      }
      const solverElapsedMs = performance.now() - startedAt;
      this.#observeStage({
        stage: "CONNECTOR_MATRIX_SEARCH",
        elapsedMs: solved.diagnostics.elapsedMs,
        units: metric(solved.diagnostics.resourceMetrics?.matrixCellCount)
      });
      this.#observeStage({ stage: "SOLVER_TOTAL", elapsedMs: solverElapsedMs, units: solved.diagnostics.candidatesGenerated });
      startedAt = performance.now();
      const boundaryAnalysis = await this.#network.routeBoundaryCrossings(request.routingSnapshot, area as JsonObject, solved.route.segments as JsonObject[], scope, context.deadline.remainingMs());
      const authoritativeRoute = withBoundaryEvents(solved.route, boundaryAnalysis.crossings);
      const verification = verifyCoverageRoute({
        problem,
        candidate: authoritativeRoute,
        currentRoutingSnapshot: network.routingSnapshot,
        networkArcs,
        objective: verifierObjective(profile),
        travelPolicy,
        turnRules,
        authoritativeBoundaryEvents: boundaryAnalysis.crossings,
        boundaryStartInside: boundaryAnalysis.startInside
      });
      this.#measure("INDEPENDENT_VERIFIER", startedAt, solved.route.segments.length);
      const admitted = admitVerifiedCoverageRoute(authoritativeRoute, verification);
      startedAt = performance.now();
      await this.#async.persistCandidate(claim, leaseOwner, {
        problemHash: digest(problem.problemHash),
        objectiveProfile: profile,
        candidateHash: digest(authoritativeRoute.routeSignature),
        route: json(authoritativeRoute),
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
      identityScope: canonicalSha256(scope),
      problemHash: digest(problem.problemHash),
      routingSnapshot: request.routingSnapshot,
      policy: { ...request.alternativePolicy, profiles: profiles as typeof request.alternativePolicy.profiles },
      candidates,
      searchTerminatedBy: candidates.length === 0 ? "NO_FEASIBLE_PLAN" : "PROFILES_COMPLETE",
      createdAt: createdAt.toISOString(),
      validUntil: new Date(createdAt.getTime() + this.#resultTtlMs).toISOString(),
      integrity: coverageIntegrity(network),
      ...(noFeasibleReasons.size === 0 ? {} : { noFeasibleReasons: [...noFeasibleReasons].sort() })
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
    const network = await this.#network.loadPinned(problem.routingSnapshot, scope, context.deadline.remainingMs());
    const freshness = await this.#network.inspectFreshness(network, scope, context.deadline.remainingMs());
    const profile = coverageObjectiveProfile(request.candidate.objectiveProfile);
    const travelPolicy: CoverageTravelPolicy = { profileKey: request.routingSnapshot.travelProfileVersion, requiredAccessMask: 0 };
    const originalRequest = artifact.request as GowmV06RoadCoverageRequest;
    const boundaryAnalysis = await this.#network.routeBoundaryCrossings(
      problem.routingSnapshot, resolvedArea(originalRequest.area) as JsonObject,
      request.candidate.route.segments as JsonObject[], scope, context.deadline.remainingMs()
    );
    let report = verifyCoverageRoute({
      problem,
      candidate: request.candidate.route,
      currentRoutingSnapshot: problem.routingSnapshot,
      networkArcs: traversalArcs(network),
      objective: verifierObjective(profile),
      travelPolicy,
      turnRules: coverageTurnRules(network),
      authoritativeBoundaryEvents: boundaryAnalysis.crossings,
      boundaryStartInside: boundaryAnalysis.startInside
    });
    report = applyCoverageCurrentness(report, freshness.currentness);
    report = withResultTtl(report, artifact.expired === true);
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

function objective(profile: CoverageObjectiveProfile): CoverageRoutingObjective {
  if (profile === "FASTEST_COMPLETION") return "FASTEST";
  if (profile === "SHORTEST_TOTAL_DISTANCE") return "SHORTEST_DISTANCE";
  if (profile === "LEAST_DEADHEAD") return "LEAST_DEADHEAD";
  if (profile === "LOWEST_RISK") return "LOWEST_RISK";
  return profile === "WEIGHTED" ? "WEIGHTED" : "BALANCED";
}

function generationProfiles(request: GowmV06RoadCoverageRequest): CoverageObjectiveProfile[] {
  const profiles: CoverageObjectiveProfile[] = [request.objective.profile];
  for (const profile of request.alternativePolicy.profiles) if (!profiles.includes(profile)) profiles.push(profile);
  return profiles;
}

function verifierObjective(profile: CoverageObjectiveProfile): "SHORTEST_DISTANCE" | "FASTEST" | "LOWEST_RISK" | "LOWEST_ENERGY" | "BALANCED" {
  const value = objective(profile);
  return value === "WEIGHTED" || value === "LEAST_DEADHEAD" ? "BALANCED" : value;
}

function objectiveWeights(request: GowmV06RoadCoverageRequest): CoverageObjectiveWeights {
  const value = request.objective.weights;
  if (value === undefined || value.distance === undefined || value.duration === undefined || value.risk === undefined || value.deadhead === undefined) {
    throw new ProviderProtocolError("INVALID_REQUEST", "WEIGHTED coverage objective requires distance, duration, risk, and deadhead PPM weights");
  }
  return { distance: value.distance, duration: value.duration, risk: value.risk, deadhead: value.deadhead };
}

function coverageObjectiveProfile(value: string): CoverageObjectiveProfile {
  if (value === "FASTEST_COMPLETION" || value === "SHORTEST_TOTAL_DISTANCE" || value === "LEAST_DEADHEAD" || value === "LOWEST_RISK" || value === "WEIGHTED") return value;
  throw new ProviderProtocolError("INVALID_REQUEST", "coverage candidate has an unsupported objective profile");
}

function noFeasibleReason(error: unknown): string | undefined {
  if (!(error instanceof CoveragePlanningError)) return undefined;
  if (error.code === "RESOURCE_EXHAUSTED") return "RESOURCE_LIMIT_PREVENTS_PROOF";
  if (error.code !== "NO_FEASIBLE_PLAN" && error.code !== "UNREACHABLE") return undefined;
  const message = error.message.toLowerCase();
  if (message.includes("turn")) return "TURN_CONSTRAINT_BLOCKED";
  if (message.includes("profile") || message.includes("excluded")) return "PROFILE_EXCLUDES_REQUIRED_ARC";
  if (message.includes("closed") || message.includes("condition")) return "CONDITION_CLOSES_REQUIRED_ARC";
  if (message.includes("endpoint") || message.includes("terminal") || message.includes("unreachable")) return "ENDPOINT_UNREACHABLE";
  return "DISCONNECTED_REQUIRED_COMPONENT";
}

function coverageIntegrity(network: LoadedNetwork): { dataSnapshotHash: `sha256:${string}`; computeSnapshotHash: `sha256:${string}`; contractHash: `sha256:${string}`; computeSnapshot: JsonObject } {
  const contractHash = getContractSchemaHash("urn:gowm:v0.6:coverage-result-set");
  const computeBody = {
    schemaVersion: "1.0", operationId: "coverage.road.plan", operationVersion: "1.0", providerVersion: "1.0.0",
    engines: [
      { name: "coverage-strict-routing", version: "1.1.0" },
      { name: "coverage-verifier", version: "1.1.0" },
      { name: "network-query-core", version: "1.0.0" },
      { name: "gowm-build-package", version: "0.6.1", digest: coverageBuildDigest() }
    ],
    policies: [{ id: "gowm-road-coverage-policy", version: "1.1", digest: canonicalSha256({ boundaryAuthority: "gowm_network_v1", weightedArithmetic: "BIGINT_PPM", leaseFencing: true }) }],
    contractHashes: [contractHash, getContractSchemaHash("urn:gowm:v0.6:road-coverage-request"), getContractSchemaHash("urn:gowm:v0.6:coverage-verification-report")]
  };
  const computeSnapshotHash = canonicalSha256(computeBody);
  const computeSnapshot = { ...computeBody, snapshotHash: computeSnapshotHash };
  return {
    dataSnapshotHash: canonicalSha256(network.dataSnapshot),
    computeSnapshotHash,
    computeSnapshot,
    contractHash
  };
}

let buildDigest: `sha256:${string}` | undefined;
function coverageBuildDigest(): `sha256:${string}` {
  if (buildDigest !== undefined) return buildDigest;
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const paths = ["./postgres-engine", "../../../../packages/road-coverage-planning-core/src/strict-routing", "../../../../packages/road-coverage-verifier-core/src/verification", "../../../../packages/road-coverage-alternatives-core/src/alternatives", "../../../../packages/network-query-core/src/repository", "../../../../packages/network-query-core/src/currentness"];
  const hash = createHash("sha256");
  for (const path of paths) { hash.update(path); hash.update("\0"); hash.update(readFileSync(new URL(`${path}.${extension}`, import.meta.url))); hash.update("\0"); }
  buildDigest = `sha256:${hash.digest("hex")}`;
  return buildDigest;
}

function withBoundaryEvents(route: GowmV06CoverageRoute, crossings: readonly BoundaryCrossing[]): GowmV06CoverageRoute {
  const { routeSignature: _routeSignature, ...body } = route;
  const boundaryEvents = crossings.map((crossing) => ({
    sequence: crossing.sequence, kind: crossing.kind, state: crossing.state, arcKey: crossing.arcKey,
    fractionPpm: crossing.fractionPpm, direction: crossing.direction, point: crossing.point,
    classification: crossing.classification, evidenceHash: crossing.evidenceHash
  }));
  const authoritative = { ...body, boundaryEvents };
  return { ...authoritative, routeSignature: canonicalSha256(authoritative) };
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

function withResultTtl(report: GowmV06CoverageVerificationReport, expired: boolean): GowmV06CoverageVerificationReport {
  const body = {
    ...report,
    status: expired && report.status === "VALID" ? "STALE" as const : report.status,
    checks: { ...report.checks, resultTtl: !expired },
    violations: [...report.violations, ...(expired ? [{ code: "RESULT_EXPIRED", message: "coverage result validUntil has elapsed" }] : [])]
  };
  const { reportHash: _oldHash, verificationId: _oldId, ...identityBody } = body;
  const identityHash = canonicalSha256(identityBody);
  const verificationId = `verify_${identityHash.slice("sha256:".length)}`;
  const { reportHash: _unused, ...withoutHash } = body;
  return { ...withoutHash, verificationId, reportHash: canonicalSha256({ ...withoutHash, verificationId }) };
}

export function applyCoverageCurrentness(report: GowmV06CoverageVerificationReport, currentness: RoutingSnapshotCurrentnessResult): GowmV06CoverageVerificationReport {
  const current = currentness.currentness === "CURRENT";
  const status = report.status === "INVALID" ? "INVALID" as const
    : currentness.currentness === "STALE" ? "STALE" as const
      : current ? report.status : "INDETERMINATE" as const;
  const violations = report.violations.filter((violation) => violation.code !== "STALE_ROUTING_SNAPSHOT");
  if (!current) violations.push({
    code: `ROUTING_CURRENTNESS_${currentness.currentness}`,
    message: currentness.reasons.join("; ") || `routing currentness is ${currentness.currentness}`
  });
  const { reportHash: _oldHash, verificationId: _oldId, ...reportBody } = report;
  const body = { ...reportBody, status, checks: { ...report.checks, currentness: current }, violations };
  const identityHash = canonicalSha256(body);
  const verificationId = `verify_${identityHash.slice("sha256:".length)}`;
  return { ...body, verificationId, reportHash: canonicalSha256({ ...body, verificationId }) };
}
