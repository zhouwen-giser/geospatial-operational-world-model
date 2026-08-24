import { sha256, stableKey } from "./canonical.js";
import type { NormalizedPosition } from "./types.js";

export function networkNodeKey(buildPolicyVersion: string, position: NormalizedPosition, topologyIdentity: string): string {
  return stableKey("nd", { buildPolicyVersion, position, topologyIdentity });
}

export function networkEdgeKey(input: {
  readonly buildPolicyVersion: string;
  readonly sourceFeatureReferenceKey: string;
  readonly sourceFeatureVersion: string;
  readonly splitStartPpm: number;
  readonly splitEndPpm: number;
  readonly sourceNodeKey: string;
  readonly targetNodeKey: string;
}): string {
  if (!Number.isInteger(input.splitStartPpm) || !Number.isInteger(input.splitEndPpm) ||
      input.splitStartPpm < 0 || input.splitEndPpm > 1_000_000 || input.splitEndPpm <= input.splitStartPpm) {
    throw new Error("invalid edge split interval");
  }
  return stableKey("ed", input);
}

export function networkArcKey(edgeKey: string, direction: "FORWARD" | "REVERSE"): string {
  return stableKey("ar", { edgeKey, direction });
}

export function graphIdentityHash(input: {
  readonly datasetReferenceKey: string;
  readonly datasetVersion: string;
  readonly datasetContentHash: string;
  readonly buildPolicyVersion: string;
  readonly sourceContentHash: string;
}): string {
  return sha256(input);
}
