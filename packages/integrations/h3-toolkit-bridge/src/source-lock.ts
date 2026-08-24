import { ProviderProtocolError } from "../../../platform/provider-sdk/src/index.js";
import type { H3ToolkitAttestation } from "./types.js";

export const H3_TOOLKIT_SOURCE_LOCK = Object.freeze({
  sourceRef: "zhouwen-giser/h3-spatial-toolkit@74fc8657072dd58a2f8e4317c1caef8bfd10e024",
  sourceGitCommit: "74fc8657072dd58a2f8e4317c1caef8bfd10e024",
  toolkitVersion: "0.3.0",
  engine: "h3-js",
  engineVersion: "4.5.0",
  license: "Apache-2.0"
} as const);

/**
 * Populated only after a reproducible build of the locked Toolkit commit has
 * produced and reviewed a self-contained bindings artifact. Empty is an
 * intentional fail-closed production state, never a wildcard.
 */
export const APPROVED_H3_TOOLKIT_BINDINGS_ARTIFACT_DIGESTS: readonly `sha256:${string}`[] = Object.freeze([]);

export function assertH3ToolkitAttestation(attestation: H3ToolkitAttestation): void {
  for (const key of ["sourceRef", "sourceGitCommit", "toolkitVersion", "engine", "engineVersion", "license"] as const) {
    if (attestation[key] !== H3_TOOLKIT_SOURCE_LOCK[key]) {
      throw new ProviderProtocolError(
        "PROVIDER_NOT_READY",
        `H3 Toolkit ${key} differs from the approved source lock`,
        { retryable: false, details: { field: key } }
      );
    }
  }
  if (!["TOOLKIT_HTTP_V1", "LOCKED_EMBEDDED_PACKAGE", "COMPOSITE_LOCKED", "TEST_DOUBLE"].includes(attestation.interfaceKind)) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "H3 Toolkit interface kind is not approved", {
      retryable: false
    });
  }
}

export function lockedAttestation(
  interfaceKind: H3ToolkitAttestation["interfaceKind"]
): H3ToolkitAttestation {
  return { ...H3_TOOLKIT_SOURCE_LOCK, interfaceKind };
}
