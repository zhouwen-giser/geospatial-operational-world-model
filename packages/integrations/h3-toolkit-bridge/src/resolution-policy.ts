import { ProviderProtocolError } from "../../../platform/provider-sdk/src/index.js";

export const GENERIC_H3_RESOLUTION_POLICY = Object.freeze({
  GLOBAL: 2,
  REGIONAL: 4,
  CITY: 7,
  DISTRICT: 8,
  STREET: 10,
  FINE: 12
} as const);

export const GENERIC_H3_POLICY_VERSION = "gowm.h3.generic-resolution/1.0";

export function resolveGenericResolution(input: unknown): number {
  const resolution = typeof input === "string"
    ? GENERIC_H3_RESOLUTION_POLICY[input as keyof typeof GENERIC_H3_RESOLUTION_POLICY]
    : input;
  if (!Number.isInteger(resolution) || (resolution as number) < 0 || (resolution as number) > 15) {
    throw new ProviderProtocolError("INVALID_REQUEST", "H3 resolution must be an integer 0..15 or a generic policy name", {
      retryable: false,
      details: { policyVersion: GENERIC_H3_POLICY_VERSION }
    });
  }
  return resolution as number;
}
