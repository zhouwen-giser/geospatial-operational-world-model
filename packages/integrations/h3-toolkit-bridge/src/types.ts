import type { DeadlineContext, TraceContext } from "../../../platform/provider-sdk/src/index.js";

export const H3_INTERACTIVE_OPERATION_IDS = [
  "h3.index.points",
  "h3.geometry.cover",
  "h3.cells.to-geojson",
  "h3.neighborhood.disk",
  "h3.hierarchy.parent",
  "h3.hierarchy.children",
  "h3.hierarchy.compact",
  "h3.hierarchy.uncompact"
] as const;

export const H3_ANALYSIS_OPERATION_IDS = [
  "h3.analytics.aggregate",
  "h3.analytics.coverage",
  "h3.analytics.flow"
] as const;

export const H3_OPERATION_IDS = [
  ...H3_INTERACTIVE_OPERATION_IDS,
  ...H3_ANALYSIS_OPERATION_IDS
] as const;

export type H3InteractiveOperationId = (typeof H3_INTERACTIVE_OPERATION_IDS)[number];
export type H3AnalysisOperationId = (typeof H3_ANALYSIS_OPERATION_IDS)[number];
export type H3OperationId = (typeof H3_OPERATION_IDS)[number];
export type Sha256Digest = `sha256:${string}`;

export interface H3ToolkitAttestation {
  sourceRef: "zhouwen-giser/h3-spatial-toolkit@74fc8657072dd58a2f8e4317c1caef8bfd10e024";
  sourceGitCommit: "74fc8657072dd58a2f8e4317c1caef8bfd10e024";
  toolkitVersion: "0.3.0";
  engine: "h3-js";
  engineVersion: "4.5.0";
  license: "Apache-2.0";
  interfaceKind: "TOOLKIT_HTTP_V1" | "LOCKED_EMBEDDED_PACKAGE" | "COMPOSITE_LOCKED" | "TEST_DOUBLE";
}

export interface H3ToolkitResult {
  data: unknown;
  warnings: string[];
  meta: {
    toolkitVersion: "0.3.0";
    engine: "h3-js";
    engineVersion: "4.5.0";
  };
}

export interface H3ToolkitReadiness {
  ready: boolean;
  reasons: string[];
  sourceGitCommit: string;
  toolkitVersion: string;
  engineVersion: string;
}

export interface H3ToolkitUpstream {
  readonly attestation: H3ToolkitAttestation;
  readonly supportedOperations: readonly H3OperationId[];
  readonly artifacts?: readonly H3ToolkitArtifact[];
  execute(
    operationId: H3OperationId,
    input: unknown,
    deadline: DeadlineContext,
    trace: TraceContext
  ): Promise<H3ToolkitResult>;
  readiness(): Promise<H3ToolkitReadiness>;
}

export interface H3ToolkitArtifact {
  kind: "IMAGE" | "PACKAGE" | "GRID" | "DATABASE";
  name: string;
  version: string;
  digest?: Sha256Digest;
}

export interface ApprovedH3ToolkitEndpoint {
  endpointId: string;
  baseUrl: string;
  approvalStatus: "APPROVED";
  configurationDigest: Sha256Digest;
  authorization?: string;
}

export interface H3ToolkitBridgeOptions {
  upstream: H3ToolkitUpstream;
  now?: () => Date;
  receiptId?: () => string;
}
