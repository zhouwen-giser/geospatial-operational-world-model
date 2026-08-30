import { HISTORICAL_OUTCOME_REASON } from "../../historical-trace-model/src/outcome.js";
import type {
  HistoricalSourceSelectionRequest,
  HistoricalSourceSelectionResult,
  HistoricalTrackletCandidate,
  TimePeriod
} from "../../historical-trace-model/src/trajectory.js";
import { intersectTimePeriods, normalizeTimePeriods } from "./trajectory-completeness.js";

function millis(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid timestamp: ${value}`);
  return parsed;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function overlapsRequested(candidate: HistoricalTrackletCandidate, requested: readonly TimePeriod[]): boolean {
  return requested.some((requestPeriod) => candidate.periods.some((candidatePeriod) =>
    intersectTimePeriods(requestPeriod, candidatePeriod) !== undefined
  ));
}

function sortCandidates(candidates: readonly HistoricalTrackletCandidate[]): HistoricalTrackletCandidate[] {
  return [...candidates].sort((left, right) =>
    compareText(left.sourceKey, right.sourceKey)
    || compareText(left.trackerSessionKey, right.trackerSessionKey)
    || compareText(left.trackletId, right.trackletId)
    || left.versionNo - right.versionNo
    || millis(left.createdAt) - millis(right.createdAt)
    || compareText(left.trackletVersionId, right.trackletVersionId)
  );
}

function indeterminate(reasonCode: string, candidates: readonly HistoricalTrackletCandidate[]): HistoricalSourceSelectionResult {
  return { status: "INDETERMINATE", reasonCode, candidates: sortCandidates(candidates) };
}

function noData(candidates: readonly HistoricalTrackletCandidate[]): HistoricalSourceSelectionResult {
  return { status: "NO_DATA", reasonCode: HISTORICAL_OUTCOME_REASON.NO_SOURCE_CANDIDATE, candidates: sortCandidates(candidates) };
}

function chooseEffectiveVersions(candidates: readonly HistoricalTrackletCandidate[]): HistoricalTrackletCandidate[] | undefined {
  const byTracklet = new Map<string, HistoricalTrackletCandidate[]>();
  for (const candidate of candidates) {
    const group = byTracklet.get(candidate.trackletId) ?? [];
    group.push(candidate);
    byTracklet.set(candidate.trackletId, group);
  }

  const effective: HistoricalTrackletCandidate[] = [];
  for (const group of byTracklet.values()) {
    const maximumVersion = Math.max(...group.map((candidate) => candidate.versionNo));
    const latest = group.filter((candidate) => candidate.versionNo === maximumVersion);
    const versionIds = new Set(latest.map((candidate) => candidate.trackletVersionId));
    if (versionIds.size !== 1) return undefined;
    effective.push(sortCandidates(latest)[0]!);
  }

  const sorted = sortCandidates(effective);
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    const left = sorted[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const right = sorted[rightIndex]!;
      if (left.trackletId === right.trackletId) continue;
      if (left.periods.some((leftPeriod) => right.periods.some((rightPeriod) => intersectTimePeriods(leftPeriod, rightPeriod) !== undefined))) {
        return undefined;
      }
    }
  }
  return sorted;
}

/**
 * Selects one authoritative Source/Session and fails closed on ambiguity. The
 * caller supplies immutable candidates; this helper applies the logical as-of
 * boundary and never consults a mutable current head.
 */
export function selectHistoricalSource(
  candidates: readonly HistoricalTrackletCandidate[],
  request: HistoricalSourceSelectionRequest
): HistoricalSourceSelectionResult {
  const capturedAt = millis(request.capturedAt);
  const requested = normalizeTimePeriods(request.requestedPeriods);
  let relevant = candidates.filter((candidate) => {
    if (!Number.isSafeInteger(candidate.versionNo) || candidate.versionNo < 1) throw new TypeError("versionNo must be a positive integer");
    return millis(candidate.createdAt) <= capturedAt
      && candidate.subjectReferenceIdentity === request.subjectReferenceIdentity
      && overlapsRequested(candidate, requested);
  });

  if (relevant.some((candidate) => candidate.bindingState === "CONFLICTED")) {
    return indeterminate(HISTORICAL_OUTCOME_REASON.ENTITY_BINDING_CONFLICT, relevant);
  }

  const selection = request.selection;
  if (selection.mode === "EXPLICIT_SOURCE") {
    relevant = relevant.filter((candidate) => candidate.sourceKey === selection.sourceKey);
    if (selection.trackerSessionKey !== undefined) {
      const trackerSessionKey = selection.trackerSessionKey;
      relevant = relevant.filter((candidate) => candidate.trackerSessionKey === trackerSessionKey);
    }
  }
  if (request.analysisSpaceIdentity !== undefined) {
    relevant = relevant.filter((candidate) => candidate.analysisSpaceIdentity === request.analysisSpaceIdentity);
  }
  if (relevant.length === 0) return noData(relevant);

  const analysisSpaces = new Set(relevant.map((candidate) => candidate.analysisSpaceIdentity));
  if (analysisSpaces.size !== 1) return indeterminate(HISTORICAL_OUTCOME_REASON.ANALYSIS_SPACE_CONFLICT, relevant);

  const sources = new Set(relevant.map((candidate) => candidate.sourceKey));
  if (sources.size !== 1) return indeterminate(HISTORICAL_OUTCOME_REASON.MULTIPLE_SOURCE_CANDIDATES, relevant);

  const sessions = new Set(relevant.map((candidate) => candidate.trackerSessionKey));
  if (sessions.size !== 1) return indeterminate(HISTORICAL_OUTCOME_REASON.MULTIPLE_TRACKER_SESSIONS, relevant);

  const effective = chooseEffectiveVersions(relevant);
  if (effective === undefined) return indeterminate(HISTORICAL_OUTCOME_REASON.MULTIPLE_TRACKLET_VERSIONS, relevant);

  return {
    status: "SELECTED",
    sourceKey: effective[0]!.sourceKey,
    trackerSessionKey: effective[0]!.trackerSessionKey,
    analysisSpaceIdentity: effective[0]!.analysisSpaceIdentity,
    candidates: effective
  };
}
