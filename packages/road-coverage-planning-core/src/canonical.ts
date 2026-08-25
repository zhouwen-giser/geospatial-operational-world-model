import { canonicalSha256 } from "../../platform/contract-runtime/src/index.js";
import type {
  ReferenceKey,
  RoadServiceObligation,
  RoutingSnapshot
} from "./types.js";

export interface ObligationIdentityInput {
  routingSnapshot: RoutingSnapshot;
  graphVersion: string;
  edgeKey?: string;
  arcKey: string;
  startFractionPpm: number;
  endFractionPpm: number;
  requiredPasses: number;
  selectionPolicyVersion: string;
  sourceAreaReferenceKey?: ReferenceKey;
  sourceFeatureReferenceKey: ReferenceKey;
}

export function buildRoadServiceObligation(input: ObligationIdentityInput): RoadServiceObligation {
  const obligationFields = {
    graphVersion: input.graphVersion,
    ...(input.edgeKey === undefined ? {} : { edgeKey: input.edgeKey }),
    arcKey: input.arcKey,
    startFractionPpm: input.startFractionPpm,
    endFractionPpm: input.endFractionPpm,
    serviceMode: "FIXED_DIRECTION" as const,
    requiredPasses: input.requiredPasses,
    selectionPolicyVersion: input.selectionPolicyVersion,
    ...(input.sourceAreaReferenceKey === undefined ? {} : { sourceAreaReferenceKey: input.sourceAreaReferenceKey }),
    sourceFeatureReferenceKey: input.sourceFeatureReferenceKey
  };
  const identityTuple = {
    routingSnapshot: input.routingSnapshot,
    ...obligationFields
  };
  const contentHash = canonicalSha256(identityTuple);
  return {
    obligationId: `obl_${contentHash.slice("sha256:".length)}`,
    ...obligationFields,
    contentHash
  };
}

export function compareObligations(left: RoadServiceObligation, right: RoadServiceObligation): number {
  return left.arcKey.localeCompare(right.arcKey) ||
    left.startFractionPpm - right.startFractionPpm ||
    left.endFractionPpm - right.endFractionPpm ||
    left.obligationId.localeCompare(right.obligationId);
}

export function canonicalObligationLedger(obligations: readonly RoadServiceObligation[]): RoadServiceObligation[] {
  return [...obligations].sort(compareObligations);
}

export function obligationSetHash(obligations: readonly RoadServiceObligation[]): `sha256:${string}` {
  return canonicalSha256(canonicalObligationLedger(obligations));
}
