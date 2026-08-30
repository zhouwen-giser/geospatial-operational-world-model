import semanticProfiles0 from "./semantic-profiles.h3-interactive.json" with { type: "json" };
import semanticProfiles1 from "./semantic-profiles.h3-analysis.json" with { type: "json" };
import { declaredSemanticProfile } from "../../../../packages/platform/provider-sdk/src/declared-semantics.js";
const DECLARED_SEMANTICS = { ...semanticProfiles0, ...semanticProfiles1 };
import {
  compareUnicodeCodePoints,
  type CapabilityDescriptor,
  type CapabilityProviderManifest
} from "../../../platform/contract-runtime/src/index.js";
import { getContractSchemaHash } from "../../../platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  ProviderProtocolError,
  sha256,
  type DeadlineContext,
  type ProviderHandlerContext,
  type ProviderOperation,
  type ProviderOperationResult,
  type ProviderRuntime,
  type ResourceConsumption
} from "../../../platform/provider-sdk/src/index.js";
import { GENERIC_H3_POLICY_VERSION, GENERIC_H3_RESOLUTION_POLICY, resolveGenericResolution } from "./resolution-policy.js";
import { H3_OPERATION_SCHEMAS } from "./schemas.js";
import { assertH3ToolkitAttestation, H3_TOOLKIT_SOURCE_LOCK } from "./source-lock.js";
import {
  H3_ANALYSIS_OPERATION_IDS,
  H3_INTERACTIVE_OPERATION_IDS,
  type H3AnalysisOperationId,
  type H3InteractiveOperationId,
  type H3OperationId,
  type H3ToolkitBridgeOptions,
  type H3ToolkitUpstream
} from "./types.js";

const INTERACTIVE_QOS = Object.freeze({
  defaultTimeoutMs: 3_000,
  maximumTimeoutMs: 10_000,
  maximumInputBytes: 16 * 1024 * 1024,
  maximumOutputBytes: 64 * 1024 * 1024,
  maximumCells: 1_000_000,
  maximumBatchItems: 100_000,
  maximumNeighborRadius: 20,
  costClass: "LOW" as const
});

const ANALYSIS_QOS = Object.freeze({
  defaultTimeoutMs: 10_000,
  maximumTimeoutMs: 30_000,
  maximumInputBytes: 64 * 1024 * 1024,
  maximumOutputBytes: 128 * 1024 * 1024,
  maximumCells: 5_000_000,
  maximumBatchItems: 100_000,
  costClass: "HIGH" as const
});

export interface H3ProviderBridge {
  runtime: ProviderRuntime;
  upstream: H3ToolkitUpstream;
  operationIds: readonly H3OperationId[];
  bodyLimitBytes: number;
}

export function createH3InteractiveProvider(options: H3ToolkitBridgeOptions): H3ProviderBridge {
  return createBridge("interactive", H3_INTERACTIVE_OPERATION_IDS, options);
}

export function createH3AnalysisProvider(options: H3ToolkitBridgeOptions): H3ProviderBridge {
  return createBridge("analysis", H3_ANALYSIS_OPERATION_IDS, options);
}

function createBridge(
  kind: "interactive" | "analysis",
  operationIds: readonly H3OperationId[],
  options: H3ToolkitBridgeOptions
): H3ProviderBridge {
  assertH3ToolkitAttestation(options.upstream.attestation);
  assertUpstreamSupports(options.upstream, operationIds);
  const qos = kind === "interactive" ? INTERACTIVE_QOS : ANALYSIS_QOS;
  const descriptors = operationIds.map((operationId) => descriptor(operationId, kind));
  const operations = descriptors.map((item) => operation(item, options.upstream, qos.maximumTimeoutMs));
  const providerId = kind === "interactive" ? "gowm.h3.interactive.bridge" : "gowm.h3.analysis.bridge";
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0", manifestSchemaVersion: "1.1",
    provider: {
      providerId,
      providerVersion: "0.2.0",
      owner: "gowm-platform",
      implementationDigest: sha256({
        providerId,
        providerVersion: "0.2.0",
        sourceGitCommit: H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit,
        operationIds,
        qos
      }),
      sourceRef: `https://github.com/zhouwen-giser/h3-spatial-toolkit/commit/${H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit}`,
      sourceGitCommit: H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit
    },
    endpoints: {
      manifest: "/v1/manifest",
      liveness: "/health/live",
      readiness: "/health/ready",
      execute: "/v1/operations/{operationId}:execute",
      job: "/v1/jobs/{jobId}"
    },
    capabilities: descriptors
  };
  const runtime = createProviderRuntime({
    manifest,
    operations,
    policyVersion: GENERIC_H3_POLICY_VERSION,
    policyDigest: sha256({
      policyVersion: GENERIC_H3_POLICY_VERSION,
      resolutionPolicy: GENERIC_H3_RESOLUTION_POLICY,
      sourceGitCommit: H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit,
      qos
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.receiptId === undefined ? {} : { receiptId: options.receiptId })
  });
  return { runtime, upstream: options.upstream, operationIds, bodyLimitBytes: qos.maximumInputBytes };
}

function descriptor(operationId: H3OperationId, kind: "interactive" | "analysis"): CapabilityDescriptor {
  const schemas = H3_OPERATION_SCHEMAS[operationId];
  const inputSchemaHash = sha256(schemas.input);
  const outputSchemaHash = sha256(schemas.output);
  const qos = kind === "interactive" ? INTERACTIVE_QOS : ANALYSIS_QOS;
  return {
    operationId,
    operationVersion: "1.0", semanticProfile: declaredSemanticProfile(DECLARED_SEMANTICS, operationId, "1.0"),
    semanticRole: kind === "interactive" ? "FOUNDATION_PRIMITIVE" : "GENERIC_ANALYSIS",
    dataBinding: "CALLER_DATA_BOUND",
    resultSemantics: kind === "interactive" ? "DERIVED_INDEX" : "DERIVED_ANALYSIS",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: kind === "interactive" ? "LOCAL_PREFERRED" : "REMOTE_ALLOWED",
    maturity: "PREVIEW",
    inputSchemaUri: schemas.inputSchemaUri,
    inputSchemaHash,
    outputSchemaUri: schemas.outputSchemaUri,
    outputSchemaHash,
    scopePolicy: "REQUEST_CONTEXT",
    execution: {
      mode: "SYNC",
      defaultTimeoutMs: qos.defaultTimeoutMs,
      maximumTimeoutMs: qos.maximumTimeoutMs,
      costClass: qos.costClass
    },
    limits: {
      maximumInputBytes: qos.maximumInputBytes,
      maximumOutputBytes: qos.maximumOutputBytes,
      maximumCells: qos.maximumCells,
      maximumCandidates: qos.maximumCells,
      maximumRows: qos.maximumCells,
      maximumBatchItems: qos.maximumBatchItems,
      maximumVertices: qos.maximumCells * 10
    },
    snapshotPolicy: { dataSnapshot: "NONE", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: schemas.inputSchemaUri,
        schemaHash: inputSchemaHash,
        valueKind: inputKind(operationId),
        unitSemantics: inputUnits(operationId)
      }],
      outputs: [{
        name: "result",
        schemaUri: schemas.outputSchemaUri,
        schemaHash: outputSchemaHash,
        valueKind: outputKind(operationId),
        unitSemantics: "DISCRETE"
      }, ...h3OutputSubports(operationId)]
    }
  };
}

function h3OutputSubports(operationId: H3OperationId): CapabilityDescriptor["ports"]["outputs"] {
  if (operationId !== "h3.geometry.cover") return [];
  return [
    {
      name: "cells",
      path: "/cells",
      schemaUri: "urn:gowm:v0.2:value:array",
      schemaHash: getContractSchemaHash("urn:gowm:v0.2:value:array"),
      valueKind: "H3_CELL_SET",
      unitSemantics: "DISCRETE"
    },
    {
      name: "candidateOnly",
      path: "/candidateOnly",
      schemaUri: "urn:gowm:v0.2:value:boolean",
      schemaHash: getContractSchemaHash("urn:gowm:v0.2:value:boolean"),
      valueKind: "SCALAR",
      unitSemantics: "DIMENSIONLESS"
    },
    {
      name: "exactVerificationRequired",
      path: "/exactVerificationRequired",
      schemaUri: "urn:gowm:v0.2:value:boolean",
      schemaHash: getContractSchemaHash("urn:gowm:v0.2:value:boolean"),
      valueKind: "SCALAR",
      unitSemantics: "DIMENSIONLESS"
    }
  ];
}

function operation(
  item: CapabilityDescriptor,
  upstream: H3ToolkitUpstream,
  maximumTimeoutMs: number
): ProviderOperation {
  const operationId = item.operationId as H3OperationId;
  const schemas = H3_OPERATION_SCHEMAS[operationId];
  return {
    descriptor: item,
    inputSchema: schemas.input,
    outputSchema: schemas.output,
    method: {
      engine: "h3-js",
      engineVersion: "4.5.0",
      methodId: methodId(operationId),
      methodVersion: "1.0",
      artifacts: [
        { kind: "PACKAGE", name: "h3-spatial-toolkit", version: "0.3.0" },
        { kind: "PACKAGE", name: "h3-js", version: "4.5.0" },
        ...(upstream.artifacts ?? [])
      ]
    },
    async handle(input, context): Promise<ProviderOperationResult<unknown>> {
      const normalizedInput = normalizeInput(operationId, input);
      const upstreamResult = await executeWithinMaximum(
        maximumTimeoutMs,
        context,
        (deadline) => upstream.execute(operationId, normalizedInput, deadline, context.trace)
      );
      const value = mapOutput(operationId, input, normalizedInput, upstreamResult.data);
      const consumption = measureConsumption(operationId, input, value);
      return {
        status: "COMPLETED",
        value,
        warnings: [
          `h3.sourceGitCommit=${H3_TOOLKIT_SOURCE_LOCK.sourceGitCommit}`,
          `h3.toolkit=${H3_TOOLKIT_SOURCE_LOCK.toolkitVersion}`,
          `h3.engine=h3-js@${H3_TOOLKIT_SOURCE_LOCK.engineVersion}`,
          ...(operationId === "h3.geometry.cover" || operationId === "h3.analytics.coverage"
            ? ["h3.cover=CENTER_CONTAINMENT_COVER", "h3.exactVerificationRequired=true"]
            : []),
          ...upstreamResult.warnings.map((warning) => `h3.upstream=${warning}`)
        ],
        consumption,
        changes: { repairApplied: false, typeChanged: false }
      };
    }
  };
}

function normalizeInput(operationId: H3OperationId, value: unknown): unknown {
  const input = asRecord(value, "H3 operation input");
  if (operationId === "h3.neighborhood.disk") {
    const radius = input.radius ?? 1;
    if (typeof radius !== "number" || radius > INTERACTIVE_QOS.maximumNeighborRadius) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "neighbor radius exceeds interactive QoS", {
        retryable: false,
        details: { maximumNeighborRadius: INTERACTIVE_QOS.maximumNeighborRadius }
      });
    }
    return { ...input, radius };
  }
  if (operationId === "h3.hierarchy.parent") {
    return { ...input, parentResolution: resolveGenericResolution(input.parentResolution) };
  }
  if (operationId === "h3.hierarchy.children") {
    return { ...input, childResolution: resolveGenericResolution(input.childResolution) };
  }
  if (operationId === "h3.analytics.flow") {
    const trajectories = asArray(input.trajectories, "flow trajectories").map((trajectory) =>
      asArray(asRecord(trajectory, "flow trajectory").points, "flow trajectory points")
    );
    return {
      trajectories,
      resolution: resolveGenericResolution(input.resolution),
      directed: input.directed !== false
    };
  }
  if (Object.hasOwn(input, "resolution")) {
    return { ...input, resolution: resolveGenericResolution(input.resolution) };
  }
  return input;
}

function mapOutput(operationId: H3OperationId, original: unknown, normalized: unknown, data: unknown): unknown {
  const input = asRecord(original, "H3 operation input");
  const canonical = asRecord(normalized, "normalized H3 input");
  switch (operationId) {
    case "h3.index.points":
      return sortedCellValues(data);
    case "h3.geometry.cover":
      return {
        schemaVersion: "1.0",
        resolution: number(canonical.resolution),
        cells: sortedCells(data),
        truncated: false,
        semantics: "CENTER_CONTAINMENT_COVER",
        candidateOnly: true,
        exactVerificationRequired: true
      };
    case "h3.cells.to-geojson":
      return data;
    case "h3.neighborhood.disk":
      return { origin: string(input.cell), radius: number(canonical.radius), cells: sortedCells(data) };
    case "h3.hierarchy.parent":
      return data;
    case "h3.hierarchy.children":
      return sortedCellValues(data);
    case "h3.hierarchy.compact":
      return { cells: sortedCells(data) };
    case "h3.hierarchy.uncompact":
      return { resolution: number(canonical.resolution), cells: sortedCells(data) };
    case "h3.analytics.aggregate":
      return { resolution: number(canonical.resolution), metrics: data };
    case "h3.analytics.coverage":
      return {
        ...asRecord(data, "Toolkit coverage result"),
        coverSemantics: "CENTER_CONTAINMENT_COVER",
        candidateOnly: true,
        exactVerificationRequired: true
      };
    case "h3.analytics.flow":
      return {
        resolution: number(canonical.resolution),
        directed: canonical.directed !== false,
        gapPolicy: "SEQUENCE_ISOLATED",
        flows: data
      };
  }
}

async function executeWithinMaximum<T>(
  maximumTimeoutMs: number,
  context: ProviderHandlerContext,
  execute: (deadline: DeadlineContext) => Promise<T>
): Promise<T> {
  const remaining = Math.min(maximumTimeoutMs, context.deadline.remainingMs());
  if (remaining <= 0) throw new ProviderProtocolError("DEADLINE_EXCEEDED", "H3 provider deadline elapsed");
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  context.deadline.signal.addEventListener("abort", forwardAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderProtocolError("DEADLINE_EXCEEDED", "H3 provider maximum operation timeout exceeded"));
    }, remaining);
    timer.unref();
  });
  const startedAt = Date.now();
  const deadline: DeadlineContext = {
    signal: controller.signal,
    deadlineAt: new Date(startedAt + remaining).toISOString(),
    remainingMs: () => Math.max(0, remaining - (Date.now() - startedAt))
  };
  try {
    return await Promise.race([execute(deadline), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    context.deadline.signal.removeEventListener("abort", forwardAbort);
  }
}

function measureConsumption(operationId: H3OperationId, input: unknown, output: unknown): ResourceConsumption {
  const request = asRecord(input, "H3 operation input");
  const result = Array.isArray(output) ? output : asRecord(output, "H3 operation output");
  switch (operationId) {
    case "h3.index.points": {
      const count = arrayLength(output);
      return { cells: count, rows: count, candidates: count, batchItems: arrayLength(request.points) };
    }
    case "h3.geometry.cover": {
      const count = arrayLength((result as Record<string, unknown>).cells);
      return { cells: count, rows: count, candidates: count, vertices: coordinateCount(request.geometry) };
    }
    case "h3.cells.to-geojson": {
      const count = arrayLength(request.cells);
      return { cells: count, rows: count, candidates: count, batchItems: count, vertices: coordinateCount(output) };
    }
    case "h3.neighborhood.disk": {
      const count = arrayLength((result as Record<string, unknown>).cells);
      return { cells: count, rows: count, candidates: count };
    }
    case "h3.hierarchy.parent":
      return { cells: 1, rows: 1, candidates: 1, batchItems: 1 };
    case "h3.hierarchy.children": {
      const count = arrayLength(output);
      return { cells: count, rows: count, candidates: count };
    }
    case "h3.hierarchy.compact":
    case "h3.hierarchy.uncompact": {
      const count = arrayLength((result as Record<string, unknown>).cells);
      return { cells: count, rows: count, candidates: count, batchItems: arrayLength(request.cells) };
    }
    case "h3.analytics.aggregate": {
      const rows = arrayLength((result as Record<string, unknown>).metrics);
      return { cells: rows, rows, candidates: arrayLength(request.records), batchItems: arrayLength(request.records) };
    }
    case "h3.analytics.coverage": {
      const candidates = arrayLength((result as Record<string, unknown>).requiredCells);
      return { cells: coverageCellCount(result as Record<string, unknown>), rows: candidates, candidates, vertices: coordinateCount(request.area) };
    }
    case "h3.analytics.flow": {
      const rows = arrayLength((result as Record<string, unknown>).flows);
      return { rows, candidates: rows, batchItems: arrayLength(request.trajectories) };
    }
  }
}

function inputKind(operationId: H3OperationId): CapabilityDescriptor["ports"]["inputs"][number]["valueKind"] {
  if (operationId === "h3.index.points") return "POSITIONS";
  if (operationId === "h3.geometry.cover" || operationId === "h3.analytics.coverage") return "GEOMETRY";
  if (operationId === "h3.cells.to-geojson" || operationId.includes("hierarchy") || operationId === "h3.neighborhood.disk") return "H3_CELL_SET";
  return "ROW_SET";
}

function outputKind(operationId: H3OperationId): CapabilityDescriptor["ports"]["outputs"][number]["valueKind"] {
  if (operationId === "h3.cells.to-geojson") return "FEATURE_COLLECTION";
  if (operationId.startsWith("h3.analytics.")) return "ROW_SET";
  if (operationId === "h3.hierarchy.parent") return "H3_CELL";
  return "H3_CELL_SET";
}

function inputUnits(operationId: H3OperationId): CapabilityDescriptor["ports"]["inputs"][number]["unitSemantics"] {
  return operationId === "h3.index.points" || operationId === "h3.geometry.cover" || operationId === "h3.analytics.coverage"
    ? "ANGULAR_DEGREES"
    : "DISCRETE";
}

function methodId(operationId: H3OperationId): string {
  const methods: Record<H3OperationId, string> = {
    "h3.index.points": "pointToCell",
    "h3.geometry.cover": "geometryToCells",
    "h3.cells.to-geojson": "cellsToGeoJSON",
    "h3.neighborhood.disk": "gridDisk",
    "h3.hierarchy.parent": "getParent",
    "h3.hierarchy.children": "getChildren",
    "h3.hierarchy.compact": "compact",
    "h3.hierarchy.uncompact": "uncompact",
    "h3.analytics.aggregate": "aggregate",
    "h3.analytics.coverage": "calculateCoverage",
    "h3.analytics.flow": "trajectoryToFlow+aggregateFlow"
  };
  return `h3-spatial-toolkit/${methods[operationId]}`;
}

function assertUpstreamSupports(upstream: H3ToolkitUpstream, operationIds: readonly H3OperationId[]): void {
  const supported = new Set(upstream.supportedOperations);
  const missing = operationIds.filter((operationId) => !supported.has(operationId));
  if (missing.length > 0) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "locked H3 Toolkit upstream lacks required operations", {
      retryable: false,
      details: { missing }
    });
  }
}

function sortedCells(value: unknown): string[] {
  const cells = asArray(value, "H3 cells");
  if (cells.some((cell) => typeof cell !== "string")) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "Toolkit cell result contains a non-string", { retryable: false });
  }
  return [...new Set(cells as string[])].sort();
}

function sortedCellValues(value: unknown): unknown[] {
  const cells = asArray(value, "H3 cell values");
  return [...cells].sort((left, right) => compareUnicodeCodePoints(string(asRecord(left, "H3 cell value").index), string(asRecord(right, "H3 cell value").index)));
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", `${name} must be an object`, { retryable: false });
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new ProviderProtocolError("SCHEMA_MISMATCH", `${name} must be an array`, { retryable: false });
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new ProviderProtocolError("SCHEMA_MISMATCH", "Toolkit string output is invalid");
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "Toolkit numeric output is invalid");
  }
  return value;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function coverageCellCount(value: Record<string, unknown>): number {
  return ["requiredCells", "visitedCells", "missingCells", "duplicateCells"]
    .reduce((total, key) => total + arrayLength(value[key]), 0);
}

function coordinateCount(value: unknown): number {
  if (Array.isArray(value)) {
    if (value.length >= 2 && value.every((item) => typeof item === "number")) return 1;
    return value.reduce((total, item) => total + coordinateCount(item), 0);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).reduce((total, item) => total + coordinateCount(item), 0);
  }
  return 0;
}

export type { H3InteractiveOperationId, H3AnalysisOperationId };
