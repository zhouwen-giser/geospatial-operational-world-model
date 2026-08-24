import { byteLength } from "./canonical.js";
import { ProviderProtocolError } from "./errors.js";

export interface ResourceLimits {
  maximumInputBytes?: number;
  maximumOutputBytes?: number;
  maximumRows?: number;
  maximumCandidates?: number;
  maximumVertices?: number;
  maximumCells?: number;
  maximumBatchItems?: number;
}

export interface ResourceConsumption {
  inputBytes?: number;
  outputBytes?: number;
  rows?: number;
  candidates?: number;
  vertices?: number;
  cells?: number;
  batchItems?: number;
}

export interface RequestedResourceLimits {
  maximumInputBytes: number;
  maximumResultBytes: number;
  maximumRows?: number;
  maximumCandidates?: number;
  maximumVertices?: number;
  maximumCells?: number;
  maximumBatchItems?: number;
}

const METRICS: ReadonlyArray<readonly [keyof ResourceConsumption, keyof ResourceLimits]> = [
  ["inputBytes", "maximumInputBytes"],
  ["outputBytes", "maximumOutputBytes"],
  ["rows", "maximumRows"],
  ["candidates", "maximumCandidates"],
  ["vertices", "maximumVertices"],
  ["cells", "maximumCells"],
  ["batchItems", "maximumBatchItems"]
];

export function assertWithinBudget(limits: ResourceLimits, usage: ResourceConsumption): void {
  for (const [usageKey, limitKey] of METRICS) {
    const consumed = usage[usageKey];
    const limit = limits[limitKey];
    if (consumed !== undefined && (!Number.isFinite(consumed) || consumed < 0)) {
      throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `invalid reported budget metric ${usageKey}`);
    }
    if (consumed !== undefined && limit !== undefined && consumed > limit) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", `${usageKey} exceeds registered ${limitKey}`, {
        details: { metric: usageKey, consumed, limit }
      });
    }
  }
}

export function inputConsumption(value: unknown): ResourceConsumption {
  return { inputBytes: byteLength(value) };
}

export function outputConsumption(value: unknown): ResourceConsumption {
  return { outputBytes: byteLength(value) };
}

export function intersectLimits(registered: ResourceLimits, requested: RequestedResourceLimits): ResourceLimits {
  const requestLimits: ResourceLimits = {
    maximumInputBytes: requested.maximumInputBytes,
    maximumOutputBytes: requested.maximumResultBytes,
    ...(requested.maximumRows === undefined ? {} : { maximumRows: requested.maximumRows }),
    ...(requested.maximumCandidates === undefined ? {} : { maximumCandidates: requested.maximumCandidates }),
    ...(requested.maximumVertices === undefined ? {} : { maximumVertices: requested.maximumVertices }),
    ...(requested.maximumCells === undefined ? {} : { maximumCells: requested.maximumCells }),
    ...(requested.maximumBatchItems === undefined ? {} : { maximumBatchItems: requested.maximumBatchItems })
  };
  const effective: ResourceLimits = {};
  for (const [, limitKey] of METRICS) {
    const registeredValue = registered[limitKey];
    const requestedValue = requestLimits[limitKey];
    if (requestedValue !== undefined && (!Number.isSafeInteger(requestedValue) || requestedValue < 1)) {
      throw new ProviderProtocolError("INVALID_REQUEST", `${limitKey} must be a positive integer`);
    }
    const value = registeredValue === undefined
      ? requestedValue
      : requestedValue === undefined
        ? registeredValue
        : Math.min(registeredValue, requestedValue);
    if (value !== undefined) effective[limitKey] = value;
  }
  return effective;
}
