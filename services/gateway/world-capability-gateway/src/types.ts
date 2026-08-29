import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  CapabilityResultEnvelope,
  ProviderExecutionRequest
} from "../../../../packages/platform/contract-runtime/src/index.js";

export interface ProviderHealth {
  live: boolean;
  ready: boolean;
  checkedAt: string;
  detail?: string;
}

export interface ProviderClient {
  readonly providerId: string;
  manifest(): Promise<CapabilityProviderManifest>;
  health(deadlineAt?: string): Promise<ProviderHealth>;
  execute(operationId: string, request: ProviderExecutionRequest): Promise<CapabilityResultEnvelope>;
}

export interface ControlledProviderBinding {
  approvalId: string;
  approved: boolean;
  endpoint: URL;
  /**
   * Deployment-only attestation for cleartext traffic on an isolated container
   * network. It is deliberately absent from public execution contracts.
   */
  allowPlaintextPrivateNetwork?: boolean;
  client: ProviderClient;
  manifest: CapabilityProviderManifest;
}

export interface ResolvedCapability {
  descriptor: CapabilityDescriptor;
  manifest: CapabilityProviderManifest;
  endpoint: URL;
  client: ProviderClient;
  approvalId: string;
}

export interface GatewayPrincipal {
  principalRef: string;
  mode?: "STATIC_SERVICE" | "SIGNED_DELEGATION_V1";
  servicePrincipalRef?: string;
  actorRef?: string;
  authenticationMethod: string;
  authenticatedAt: string;
  dataScopeClaim?: string;
  datasetScopeClaim?: string;
  effectiveDataScopes?: string[];
  effectiveDatasetScopes?: string[];
  allowedOperations?: string[];
  delegationJtiHash?: `sha256:${string}`;
  authorizationContextHash?: `sha256:${string}`;
  allowExperimental?: boolean;
}

export interface AuditEvent {
  eventId: string;
  occurredAt: string;
  requestId: string;
  principalRef: string;
  operationId: string;
  operationVersion: string;
  providerId?: string;
  outcome: "ACCEPTED" | "REPLAYED" | "COMPLETED" | "REJECTED" | "FAILED";
  inputHash: string;
  outputHash?: string;
  dataScopeHash?: `sha256:${string}`;
  errorCode?: string;
  elapsedMs?: number;
  delegationJtiHash?: `sha256:${string}`;
  authorizationContextHash?: `sha256:${string}`;
}

export interface AuditSink {
  append(event: Readonly<AuditEvent>): Promise<void>;
}
