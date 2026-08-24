import {
  ProviderProtocolError,
  type DeadlineContext,
  type TraceContext
} from "../../../platform/provider-sdk/src/index.js";
import { assertH3ToolkitAttestation, lockedAttestation } from "./source-lock.js";
import type {
  H3OperationId,
  H3ToolkitArtifact,
  H3ToolkitReadiness,
  H3ToolkitResult,
  H3ToolkitUpstream
} from "./types.js";
import { H3_OPERATION_IDS } from "./types.js";

export interface LockedExternalH3ToolkitBindings {
  pointToCell(point: unknown, resolution: number): unknown;
  geometryToCells(geometry: unknown, resolution: number): string[];
  cellsToGeoJSON(cells: string[]): unknown;
  gridDisk(cell: string, radius: number): string[];
  getParent(cell: string, resolution: number): unknown;
  getChildren(cell: string, resolution: number): unknown[];
  compact(cells: string[]): string[];
  uncompact(cells: string[], resolution: number): string[];
  aggregate(records: unknown[], operation: string, resolution: number, metric?: string): unknown[];
  calculateCoverage(input: unknown): unknown;
  trajectoryToFlow(points: unknown[], resolution: number): unknown | null;
  aggregateFlow(flows: unknown[], directed: boolean): unknown[];
  selfCheck(): string;
}

export interface LockedExternalH3ToolkitAdapterOptions {
  supportedOperations?: readonly H3OperationId[];
  artifactDigest?: `sha256:${string}`;
}

const REQUIRED_BINDINGS: Readonly<Record<H3OperationId, keyof LockedExternalH3ToolkitBindings>> = Object.freeze({
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
  "h3.analytics.flow": "trajectoryToFlow"
});

/**
 * Thin invocation adapter over the immutable external Toolkit package API.
 * The algorithms remain exclusively in that package; GOWM supplies only
 * operation routing, source-lock verification, and protocol mapping.
 */
export class LockedExternalH3ToolkitAdapter implements H3ToolkitUpstream {
  readonly attestation = lockedAttestation("LOCKED_EMBEDDED_PACKAGE");
  readonly supportedOperations: readonly H3OperationId[];
  readonly artifacts?: readonly H3ToolkitArtifact[];

  constructor(
    private readonly bindings: LockedExternalH3ToolkitBindings,
    options: LockedExternalH3ToolkitAdapterOptions = {}
  ) {
    assertH3ToolkitAttestation(this.attestation);
    const supported = [...(options.supportedOperations ?? H3_OPERATION_IDS)];
    if (supported.length === 0 || new Set(supported).size !== supported.length ||
        supported.some((operationId) => !H3_OPERATION_IDS.includes(operationId))) {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "external Toolkit operation allowlist is invalid", {
        retryable: false
      });
    }
    this.supportedOperations = Object.freeze(supported);
    const required = new Set<keyof LockedExternalH3ToolkitBindings>(["selfCheck"]);
    for (const operationId of supported) {
      required.add(REQUIRED_BINDINGS[operationId]);
      if (operationId === "h3.analytics.flow") required.add("aggregateFlow");
    }
    for (const name of required) {
      if (typeof bindings[name] !== "function") {
        throw new ProviderProtocolError("PROVIDER_NOT_READY", `external Toolkit binding ${name} is missing`, {
          retryable: false
        });
      }
    }
    if (bindings.selfCheck() !== "892f5a32d97ffff") {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "external Toolkit h3-js 4.5.0 self-check failed", {
        retryable: false
      });
    }
    if (options.artifactDigest !== undefined) {
      if (!/^sha256:[0-9a-f]{64}$/u.test(options.artifactDigest)) {
        throw new ProviderProtocolError("PROVIDER_NOT_READY", "external Toolkit binding artifact digest is invalid", {
          retryable: false
        });
      }
      this.artifacts = Object.freeze([{
        kind: "PACKAGE",
        name: "h3-toolkit-bindings",
        version: "0.3.0",
        digest: options.artifactDigest
      }]);
    }
  }

  async execute(
    operationId: H3OperationId,
    input: unknown,
    deadline: DeadlineContext,
    _trace: TraceContext
  ): Promise<H3ToolkitResult> {
    if (!this.supportedOperations.includes(operationId)) {
      throw new ProviderProtocolError("OPERATION_NOT_FOUND", `external Toolkit adapter does not expose ${operationId}`, {
        retryable: false
      });
    }
    if (deadline.signal.aborted || deadline.remainingMs() <= 0) {
      throw new ProviderProtocolError("DEADLINE_EXCEEDED", "H3 Toolkit deadline elapsed before execution");
    }
    try {
      const record = asRecord(input);
      const data = this.invoke(operationId, record);
      return {
        data,
        warnings: [],
        meta: { toolkitVersion: "0.3.0", engine: "h3-js", engineVersion: "4.5.0" }
      };
    } catch (error) {
      if (error instanceof ProviderProtocolError) throw error;
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code.endsWith("_LIMIT_EXCEEDED")) {
        throw new ProviderProtocolError("BUDGET_EXCEEDED", "external Toolkit rejected the resource budget", {
          retryable: false,
          details: { upstreamCode: code },
          cause: error
        });
      }
      if (code) {
        throw new ProviderProtocolError("INVALID_REQUEST", "external Toolkit rejected the operation input", {
          retryable: false,
          details: { upstreamCode: code },
          cause: error
        });
      }
      throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "external Toolkit package execution failed", {
        cause: error
      });
    }
  }

  async readiness(): Promise<H3ToolkitReadiness> {
    const reasons = this.bindings.selfCheck() === "892f5a32d97ffff" ? [] : ["h3-js self-check failed"];
    return {
      ready: reasons.length === 0,
      reasons,
      sourceGitCommit: this.attestation.sourceGitCommit,
      toolkitVersion: this.attestation.toolkitVersion,
      engineVersion: this.attestation.engineVersion
    };
  }

  private invoke(operationId: H3OperationId, input: Record<string, unknown>): unknown {
    switch (operationId) {
      case "h3.index.points":
        return asArray(input.points).map((point) => this.bindings.pointToCell(point, number(input.resolution)));
      case "h3.geometry.cover":
        return this.bindings.geometryToCells(input.geometry, number(input.resolution));
      case "h3.cells.to-geojson":
        return this.bindings.cellsToGeoJSON(stringArray(input.cells));
      case "h3.neighborhood.disk":
        return this.bindings.gridDisk(string(input.cell), number(input.radius));
      case "h3.hierarchy.parent":
        return this.bindings.getParent(string(input.cell), number(input.parentResolution));
      case "h3.hierarchy.children":
        return this.bindings.getChildren(string(input.cell), number(input.childResolution));
      case "h3.hierarchy.compact":
        return this.bindings.compact(stringArray(input.cells));
      case "h3.hierarchy.uncompact":
        return this.bindings.uncompact(stringArray(input.cells), number(input.resolution));
      case "h3.analytics.aggregate":
        return this.bindings.aggregate(
          asArray(input.records),
          string(input.operation),
          number(input.resolution),
          typeof input.metric === "string" ? input.metric : undefined
        );
      case "h3.analytics.coverage":
        return this.bindings.calculateCoverage(input);
      case "h3.analytics.flow": {
        const flows = asArray(input.trajectories)
          .map((trajectory) => this.bindings.trajectoryToFlow(asArray(trajectory), number(input.resolution)))
          .filter((flow): flow is Exclude<typeof flow, null> => flow !== null);
        return this.bindings.aggregateFlow(flows, input.directed !== false);
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ProviderProtocolError("INVALID_REQUEST", "H3 Toolkit input must be an object");
  return value;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ProviderProtocolError("INVALID_REQUEST", "H3 Toolkit input must be an array");
  return value;
}

function stringArray(value: unknown): string[] {
  const values = asArray(value);
  if (values.some((item) => typeof item !== "string")) {
    throw new ProviderProtocolError("INVALID_REQUEST", "H3 cell collection must contain strings");
  }
  return values as string[];
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new ProviderProtocolError("INVALID_REQUEST", "H3 Toolkit string input is invalid");
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProviderProtocolError("INVALID_REQUEST", "H3 Toolkit numeric input is invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
