import { compareUnicodeCodePoints } from "../../platform/contract-runtime/src/index.js";
import { sha256, stableKey } from "./canonical.js";
import type {
  BuiltNetworkArc,
  BuiltNetworkTopology,
  BuiltPairwiseTurnRule,
  BuiltTurnSequenceRule,
  CompiledTurnRestrictions,
  SequenceRestrictionAutomaton,
  SourcePairwiseTurnRestriction,
  SourceSequenceTurnRestriction,
  TurnRestrictionDiagnostic,
  TurnRuleType
} from "./types.js";

function validatePenalty(ruleType: TurnRuleType, penaltyUnits: number | undefined): number {
  const value = penaltyUnits ?? 0;
  if (!Number.isSafeInteger(value) || value < 0 || (ruleType === "PENALTY" ? value === 0 : value !== 0)) {
    throw new Error("turn restriction penalty is inconsistent with rule type");
  }
  return value;
}

function arcsByFeature(topology: BuiltNetworkTopology): Map<string, BuiltNetworkArc[]> {
  const edgeFeatures = new Map(topology.edges.map((edge) => [edge.edgeKey, edge.sourceFeatureReferenceKey]));
  const result = new Map<string, BuiltNetworkArc[]>();
  for (const arc of topology.arcs) {
    const featureKey = edgeFeatures.get(arc.edgeKey);
    if (!featureKey) throw new Error("turn compiler found an Arc without its physical Edge");
    const collection = result.get(featureKey) ?? [];
    collection.push(arc);
    result.set(featureKey, collection);
  }
  for (const collection of result.values()) collection.sort((left, right) => compareUnicodeCodePoints(left.arcKey, right.arcKey));
  return result;
}

function contiguousSequences(featureKeys: readonly string[], index: Map<string, BuiltNetworkArc[]>): BuiltNetworkArc[][] {
  if (featureKeys.length < 2) throw new Error("turn restriction requires at least two source features");
  let paths = (index.get(featureKeys[0]!) ?? []).map((arc) => [arc]);
  for (const featureKey of featureKeys.slice(1)) {
    const candidates = index.get(featureKey) ?? [];
    paths = paths.flatMap((path) => candidates
      .filter((candidate) => path.at(-1)?.targetNodeKey === candidate.sourceNodeKey)
      .map((candidate) => [...path, candidate]));
  }
  return paths;
}

function diagnostic(referenceKey: string, ruleType: TurnRuleType, candidateCount: number): TurnRestrictionDiagnostic {
  const hard = ruleType !== "PENALTY";
  return {
    severity: hard ? "FATAL" : "WARNING",
    issueCode: hard ? "UNRESOLVED_HARD_TURN_RESTRICTION" : "UNRESOLVED_SOFT_TURN_RESTRICTION",
    activationBlocking: hard,
    restrictionReferenceKey: referenceKey,
    reason: candidateCount === 0 ? "ZERO_MATCHES" : "AMBIGUOUS_MATCHES",
    candidateCount
  };
}

function automatonFor(rules: readonly Omit<BuiltTurnSequenceRule, "automatonHash" | "contentHash">[]): SequenceRestrictionAutomaton {
  const prefixKeys = new Set<string>([""]);
  const prefixes: string[][] = [[]];
  for (const rule of rules) {
    for (let length = 1; length <= rule.arcSequence.length; length += 1) {
      const prefix = rule.arcSequence.slice(0, length);
      const key = prefix.join("\u0000");
      if (!prefixKeys.has(key)) {
        prefixKeys.add(key);
        prefixes.push([...prefix]);
      }
    }
  }
  prefixes.sort((left, right) => left.length - right.length || compareUnicodeCodePoints(left.join("\u0000"), right.join("\u0000")));
  const states = prefixes.map((prefix, stateId) => ({ stateId, prefix }));
  const normalizedRules = rules.map(({ ruleKey, arcSequence, ruleType, penaltyUnits }) => ({
    ruleKey, arcSequence, ruleType, penaltyUnits
  })).sort((left, right) => compareUnicodeCodePoints(left.ruleKey, right.ruleKey));
  const automatonHash = sha256({ states, rules: normalizedRules });
  return { states, rules: normalizedRules, automatonHash };
}

export function advanceSequenceAutomaton(
  automaton: SequenceRestrictionAutomaton,
  stateId: number,
  arcKey: string
): { stateId: number; matchedRuleKeys: readonly string[]; forbidden: boolean; penaltyUnits: number } {
  const state = automaton.states.find((candidate) => candidate.stateId === stateId);
  if (!state) throw new Error("turn automaton state is unavailable");
  const candidate = [...state.prefix, arcKey];
  const matched = automaton.rules.filter((rule) =>
    rule.arcSequence.length <= candidate.length &&
    rule.arcSequence.every((item, index) => item === candidate[candidate.length - rule.arcSequence.length + index])
  );
  const next = [...automaton.states]
    .sort((left, right) => right.prefix.length - left.prefix.length || left.stateId - right.stateId)
    .find((possible) => possible.prefix.length <= candidate.length &&
      possible.prefix.every((item, index) => item === candidate[candidate.length - possible.prefix.length + index]));
  if (!next) throw new Error("turn automaton lacks its empty state");
  return {
    stateId: next.stateId,
    matchedRuleKeys: matched.map((rule) => rule.ruleKey).sort(),
    forbidden: matched.some((rule) => rule.ruleType === "FORBIDDEN"),
    penaltyUnits: matched.reduce((sum, rule) => sum + rule.penaltyUnits, 0)
  };
}

export function compileTurnRestrictions(input: {
  readonly topology: BuiltNetworkTopology;
  readonly pairwise: readonly SourcePairwiseTurnRestriction[];
  readonly sequences: readonly SourceSequenceTurnRestriction[];
}): CompiledTurnRestrictions {
  const index = arcsByFeature(input.topology);
  const diagnostics: TurnRestrictionDiagnostic[] = [];
  const pairwiseRules: BuiltPairwiseTurnRule[] = [];
  for (const source of input.pairwise) {
    const candidates = contiguousSequences([source.fromFeatureReferenceKey, source.toFeatureReferenceKey], index)
      .filter(([from, to]) => from?.targetNodeKey === source.viaNodeKey && to?.sourceNodeKey === source.viaNodeKey);
    if (candidates.length !== 1) {
      diagnostics.push(diagnostic(source.restrictionReferenceKey, source.ruleType, candidates.length));
      continue;
    }
    const [from, to] = candidates[0]!;
    if (!from || !to) throw new Error("pairwise compiler produced an incomplete candidate");
    const penaltyUnits = validatePenalty(source.ruleType, source.penaltyUnits);
    const normalized = {
      fromArcKey: from.arcKey,
      viaNodeKey: source.viaNodeKey,
      toArcKey: to.arcKey,
      ruleType: source.ruleType,
      penaltyUnits,
      profileFilter: source.profileFilter ?? {},
      evidence: source.evidence ?? []
    };
    const ruleKey = stableKey("tr", { restrictionReferenceKey: source.restrictionReferenceKey, ...normalized });
    pairwiseRules.push({ ruleKey, ...normalized, contentHash: sha256({ ruleKey, ...normalized }) });
  }

  const pendingSequences: Array<Omit<BuiltTurnSequenceRule, "automatonHash" | "contentHash">> = [];
  for (const source of input.sequences) {
    const candidates = contiguousSequences(source.featureReferenceKeys, index);
    if (candidates.length !== 1) {
      diagnostics.push(diagnostic(source.restrictionReferenceKey, source.ruleType, candidates.length));
      continue;
    }
    const arcSequence = candidates[0]!.map((arc) => arc.arcKey);
    const penaltyUnits = validatePenalty(source.ruleType, source.penaltyUnits);
    const normalized = {
      arcSequence,
      ruleType: source.ruleType,
      penaltyUnits,
      profileFilter: source.profileFilter ?? {},
      evidence: source.evidence ?? []
    };
    const ruleKey = stableKey("ts", { restrictionReferenceKey: source.restrictionReferenceKey, ...normalized });
    pendingSequences.push({ ruleKey, ...normalized });
  }
  pairwiseRules.sort((left, right) => compareUnicodeCodePoints(left.ruleKey, right.ruleKey));
  pendingSequences.sort((left, right) => compareUnicodeCodePoints(left.ruleKey, right.ruleKey));
  diagnostics.sort((left, right) => compareUnicodeCodePoints(left.restrictionReferenceKey, right.restrictionReferenceKey));
  const automaton = automatonFor(pendingSequences);
  const sequenceRules = pendingSequences.map((rule) => ({
    ...rule,
    automatonHash: automaton.automatonHash,
    contentHash: sha256({ ...rule, automatonHash: automaton.automatonHash })
  }));
  return {
    pairwiseRules,
    sequenceRules,
    automaton,
    diagnostics,
    contentHash: sha256({ pairwiseRules, sequenceRules, diagnostics, automatonHash: automaton.automatonHash })
  };
}
