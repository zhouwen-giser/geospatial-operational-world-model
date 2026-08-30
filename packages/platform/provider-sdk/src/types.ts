import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  CapabilityResultEnvelope,
  DataSnapshotContext,
  EvidenceReference,
  GowmV07QuerySnapshotManifest,
  ProviderExecutionRequest
} from "../../contract-runtime/src/index.js";
import type { ResourceConsumption } from "./budget.js";
import type { DeadlineContext } from "./deadline.js";
import type { TrustedSecurityContext } from "./scope.js";
import type { TraceContext } from "./trace.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ProviderMethod {
  engine: string;
  engineVersion: string;
  methodId: string;
  methodVersion: string;
  engineDigest?: `sha256:${string}`;
  artifacts?: ReadonlyArray<{
    kind: "IMAGE" | "PACKAGE" | "GRID" | "DATABASE";
    name: string;
    version: string;
    digest?: `sha256:${string}`;
  }>;
}

export interface ProviderOperationResult<Output> {
  status: "COMPLETED" | "PARTIAL" | "NO_DATA" | "INDETERMINATE";
  value?: Output;
  dataSnapshot?: DataSnapshotContext;
  evidenceReferences?: EvidenceReference[];
  warnings?: string[];
  consumption?: ResourceConsumption;
  changes?: {
    repairApplied: boolean;
    typeChanged: boolean;
    inputGeometryType?: string;
    outputGeometryType?: string;
  };
}

export interface ProviderHandlerContext {
  security: TrustedSecurityContext;
  deadline: DeadlineContext;
  trace: TraceContext;
  gateway: ProviderExecutionRequest["gatewayContext"];
  snapshots: ProviderSnapshotContext;
}

export interface ProviderSnapshotContext {
  requested?: GowmV07QuerySnapshotManifest;
  effective?: GowmV07QuerySnapshotManifest;
}

export interface ProviderOperation<Input = unknown, Output = unknown> {
  descriptor: CapabilityDescriptor;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  /** Frozen source-byte hash when a contract manifest locks the schema artifact rather than canonical JSON. */
  inputSchemaLockHash?: `sha256:${string}`;
  /** Frozen source-byte hash when a contract manifest locks the schema artifact rather than canonical JSON. */
  outputSchemaLockHash?: `sha256:${string}`;
  method: ProviderMethod;
  handle(input: Input, context: ProviderHandlerContext): Promise<ProviderOperationResult<Output>>;
}

export interface ProviderRuntimeOptions {
  manifest: CapabilityProviderManifest;
  operations: readonly ProviderOperation[];
  policyVersion: string;
  policyDigest: `sha256:${string}`;
  now?: () => Date;
  receiptId?: () => string;
  maximumIdempotencyEntries?: number;
}

export interface ProviderRuntime {
  readonly manifest: CapabilityProviderManifest;
  execute(request: ProviderExecutionRequest, traceId?: string): Promise<CapabilityResultEnvelope>;
  health(): { live: true; providerId: string; providerVersion: string };
  readiness(): { ready: boolean; providerId: string; operationCount: number; reasons: string[] };
}
