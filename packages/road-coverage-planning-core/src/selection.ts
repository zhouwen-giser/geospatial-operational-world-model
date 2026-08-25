import { canonicalSha256 } from "../../platform/contract-runtime/src/index.js";
import { buildRoadServiceObligation, canonicalObligationLedger, obligationSetHash } from "./canonical.js";
import { CoveragePlanningError } from "./errors.js";
import type {
  CoverageSelectionCandidate,
  CoverageSelectionRepository,
  CoverageSelectionRequest,
  CoverageSelectionResult,
  ReferenceKey,
  RoadServiceObligation
} from "./types.js";

export async function selectRoadServiceObligations(
  repository: CoverageSelectionRepository,
  request: CoverageSelectionRequest
): Promise<CoverageSelectionResult> {
  validateRequest(request);
  const policyVersion = request.policy.selectionPolicyVersion ?? "coverage-selection/1.0";
  const areaReferenceKey = isReferenceKey(request.area) ? request.area : undefined;
  const areaGeometry = isReferenceKey(request.area) ? request.resolvedArea : request.area;
  if (request.policy.mode !== "MANUAL_OBLIGATIONS" && areaGeometry === undefined) {
    throw new CoveragePlanningError("INVALID_AREA", "area ReferenceKey must be resolved before selection");
  }

  let candidates: CoverageSelectionCandidate[];
  let obligations: RoadServiceObligation[];
  if (request.policy.mode === "MANUAL_OBLIGATIONS") {
    const manual = request.policy.manualObligations ?? [];
    candidates = await repository.validateManual(request, manual.map((item) => item.arcKey));
    obligations = normalizeManualObligations(request, manual, candidates, policyVersion, areaReferenceKey);
  } else {
    candidates = await repository.select(request);
    const selected = chooseDirections(candidates, request.policy.serviceMode, request.policy.fixedDirectionSource);
    obligations = selected.map((candidate) => buildRoadServiceObligation({
      routingSnapshot: request.routingSnapshot,
      graphVersion: candidate.graphVersion,
      edgeKey: candidate.edgeKey,
      arcKey: candidate.arcKey,
      startFractionPpm: candidate.startFractionPpm,
      endFractionPpm: candidate.endFractionPpm,
      requiredPasses: request.policy.requiredPasses,
      selectionPolicyVersion: policyVersion,
      ...(areaReferenceKey === undefined ? {} : { sourceAreaReferenceKey: areaReferenceKey }),
      sourceFeatureReferenceKey: featureReference(candidate.sourceFeatureReferenceId, request.routingSnapshot.networkDatasetVersion)
    }));
  }
  if (candidates.length > request.maximumSelectionCandidates) {
    throw new CoveragePlanningError(
      "RESOURCE_EXHAUSTED",
      `road selection exceeded ${request.maximumSelectionCandidates} candidates`
    );
  }

  const ledger = canonicalObligationLedger(dedupe(obligations));
  if (ledger.length === 0) {
    throw new CoveragePlanningError("NO_OBLIGATIONS", "selection produced no service obligations; v0.6 empty-selection policy is DENY");
  }
  const receipt = {
    schemaVersion: "1.0" as const,
    method: request.policy.mode === "MANUAL_OBLIGATIONS"
      ? "VALIDATED_MANUAL_OBLIGATIONS_V1" as const
      : "POSTGIS_BOUNDARY_INCLUSIVE_FRACTION_PPM_V1" as const,
    mode: request.policy.mode,
    routingSnapshot: request.routingSnapshot,
    selectionPolicyVersion: policyVersion,
    areaHash: canonicalSha256(areaGeometry ?? request.area),
    ...(areaReferenceKey === undefined ? {} : { areaReferenceKey }),
    candidateCount: candidates.length,
    obligationCount: ledger.length,
    minimumSegmentLengthMm: request.policy.minimumSegmentLengthMm,
    boundaryToleranceMm: request.policy.boundaryToleranceMm ?? 0
  };
  const selectionReceiptHash = canonicalSha256(receipt);
  const ledgerHash = obligationSetHash(ledger);
  return {
    receipt,
    obligationSet: {
      schemaVersion: "1.0",
      obligationSetId: `obls_${ledgerHash.slice("sha256:".length)}`,
      routingSnapshot: request.routingSnapshot,
      selectionMode: request.policy.mode,
      obligations: ledger,
      obligationCount: ledger.length,
      totalRequiredLengthMm: totalRequiredLength(candidates, ledger),
      selectionReceiptHash,
      warnings: []
    }
  };
}

function validateRequest(request: CoverageSelectionRequest): void {
  if (!request.dataScopeKey || !request.datasetScopeKey) {
    throw new CoveragePlanningError("SCOPE_DENIED", "data and dataset scope are required before selection");
  }
  if (!Number.isSafeInteger(request.maximumSelectionCandidates) || request.maximumSelectionCandidates < 1) {
    throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "maximumSelectionCandidates must be a positive integer");
  }
  if (!Number.isSafeInteger(request.policy.requiredPasses) || request.policy.requiredPasses < 1 || request.policy.requiredPasses > 10) {
    throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "requiredPasses must be between 1 and 10");
  }
  if (!Number.isSafeInteger(request.policy.minimumSegmentLengthMm) || request.policy.minimumSegmentLengthMm < 0) {
    throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "minimumSegmentLengthMm must be non-negative");
  }
  if (request.policy.serviceMode === "FIXED_DIRECTION" && request.policy.fixedDirectionSource === undefined) {
    throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "FIXED_DIRECTION requires an authoritative fixedDirectionSource");
  }
  if (request.policy.mode !== "MANUAL_OBLIGATIONS" && request.policy.fixedDirectionSource === "MANUAL") {
    throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "MANUAL direction authority is valid only for manual obligations");
  }
}

function chooseDirections(
  candidates: readonly CoverageSelectionCandidate[],
  serviceMode: "FIXED_DIRECTION" | "BOTH_DIRECTIONS",
  source: "MANUAL" | "SOURCE_FEATURE_ATTRIBUTE" | "APPROVED_POLICY" | undefined
): CoverageSelectionCandidate[] {
  if (serviceMode === "BOTH_DIRECTIONS") return [...candidates];
  const grouped = new Map<string, CoverageSelectionCandidate[]>();
  for (const candidate of candidates) {
    const physicalStart = candidate.direction === "REVERSE" ? 1_000_000 - candidate.endFractionPpm : candidate.startFractionPpm;
    const physicalEnd = candidate.direction === "REVERSE" ? 1_000_000 - candidate.startFractionPpm : candidate.endFractionPpm;
    const key = `${candidate.edgeKey}:${physicalStart}:${physicalEnd}`;
    const items = grouped.get(key) ?? [];
    items.push(candidate);
    grouped.set(key, items);
  }
  const selected: CoverageSelectionCandidate[] = [];
  for (const items of grouped.values()) {
    const sorted = [...items].sort((left, right) => left.arcKey.localeCompare(right.arcKey));
    if (source === "SOURCE_FEATURE_ATTRIBUTE") {
      const authoritativeDirection = sorted[0]?.oneway;
      if (authoritativeDirection === "BIDIRECTIONAL") {
        throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "source feature does not provide a fixed direction");
      }
      const direction = authoritativeDirection === "REVERSE_ONLY" ? "REVERSE" : "FORWARD";
      const match = sorted.find((candidate) => candidate.direction === direction);
      if (!match) throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "source fixed direction has no legal arc");
      selected.push(match);
    } else if (source === "APPROVED_POLICY") {
      const match = sorted.find((candidate) => candidate.direction === "FORWARD") ?? sorted[0];
      if (match) selected.push(match);
    } else {
      throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "fixed direction authority is unavailable");
    }
  }
  return selected;
}

function normalizeManualObligations(
  request: CoverageSelectionRequest,
  manual: readonly RoadServiceObligation[],
  candidates: readonly CoverageSelectionCandidate[],
  policyVersion: string,
  areaReferenceKey: ReferenceKey | undefined
): RoadServiceObligation[] {
  if (manual.length === 0) return [];
  const byArc = new Map(candidates.map((candidate) => [candidate.arcKey, candidate]));
  return manual.map((item) => {
    const candidate = byArc.get(item.arcKey);
    if (!candidate || candidate.graphVersion !== request.routingSnapshot.graphVersion) {
      throw new CoveragePlanningError("VERSION_NOT_FOUND", `manual obligation arc ${item.arcKey} is unavailable in the pinned scope`);
    }
    if (item.startFractionPpm < 0 || item.endFractionPpm > 1_000_000 || item.startFractionPpm >= item.endFractionPpm) {
      throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "manual obligation fractions must be ordered within 0..1,000,000");
    }
    return buildRoadServiceObligation({
      routingSnapshot: request.routingSnapshot,
      graphVersion: candidate.graphVersion,
      edgeKey: candidate.edgeKey,
      arcKey: candidate.arcKey,
      startFractionPpm: item.startFractionPpm,
      endFractionPpm: item.endFractionPpm,
      requiredPasses: item.requiredPasses,
      selectionPolicyVersion: item.selectionPolicyVersion ?? policyVersion,
      ...(areaReferenceKey === undefined ? {} : { sourceAreaReferenceKey: areaReferenceKey }),
      sourceFeatureReferenceKey: featureReference(candidate.sourceFeatureReferenceId, request.routingSnapshot.networkDatasetVersion)
    });
  });
}

function totalRequiredLength(
  candidates: readonly CoverageSelectionCandidate[],
  obligations: readonly RoadServiceObligation[]
): number {
  const lengths = new Map(candidates.map((candidate) => [
    `${candidate.arcKey}:${candidate.startFractionPpm}:${candidate.endFractionPpm}`,
    candidate.requiredLengthMm
  ]));
  return obligations.reduce((total, obligation) => {
    const exact = lengths.get(`${obligation.arcKey}:${obligation.startFractionPpm}:${obligation.endFractionPpm}`);
    const full = lengths.get(`${obligation.arcKey}:0:1000000`);
    const length = exact ?? (full === undefined ? 0 : Math.round(
      full * (obligation.endFractionPpm - obligation.startFractionPpm) / 1_000_000
    ));
    return total + length * obligation.requiredPasses;
  }, 0);
}

function dedupe(obligations: readonly RoadServiceObligation[]): RoadServiceObligation[] {
  return [...new Map(obligations.map((item) => [item.obligationId, item])).values()];
}

function featureReference(id: string, version: string): ReferenceKey {
  return { namespace: "gowm", kind: "LAYER_FEATURE", id, version };
}

function isReferenceKey(value: CoverageSelectionRequest["area"]): value is ReferenceKey {
  return !("type" in value);
}
