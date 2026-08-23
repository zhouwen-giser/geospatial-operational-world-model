import { ProviderProtocolError, type DeadlineContext, type TraceContext } from "../../../platform/provider-sdk/src/index.js";
import { assertH3ToolkitAttestation, lockedAttestation } from "./source-lock.js";
import type {
  H3OperationId,
  H3ToolkitReadiness,
  H3ToolkitResult,
  H3ToolkitArtifact,
  H3ToolkitUpstream
} from "./types.js";

export class CompositeH3ToolkitUpstream implements H3ToolkitUpstream {
  readonly attestation = lockedAttestation("COMPOSITE_LOCKED");
  readonly supportedOperations: readonly H3OperationId[];
  readonly artifacts?: readonly H3ToolkitArtifact[];
  private readonly routes = new Map<H3OperationId, H3ToolkitUpstream>();

  constructor(private readonly delegates: readonly H3ToolkitUpstream[]) {
    if (delegates.length === 0) {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "composite H3 Toolkit upstream requires delegates", {
        retryable: false
      });
    }
    assertH3ToolkitAttestation(this.attestation);
    for (const delegate of delegates) {
      assertH3ToolkitAttestation(delegate.attestation);
      for (const operationId of delegate.supportedOperations) {
        if (!this.routes.has(operationId)) this.routes.set(operationId, delegate);
      }
    }
    this.supportedOperations = [...this.routes.keys()];
    const artifacts = delegates.flatMap((delegate) => delegate.artifacts ?? []);
    if (artifacts.length > 0) {
      this.artifacts = Object.freeze([...new Map(artifacts.map((artifact) => [JSON.stringify(artifact), artifact])).values()]);
    }
  }

  execute(
    operationId: H3OperationId,
    input: unknown,
    deadline: DeadlineContext,
    trace: TraceContext
  ): Promise<H3ToolkitResult> {
    const delegate = this.routes.get(operationId);
    if (!delegate) {
      throw new ProviderProtocolError("OPERATION_NOT_FOUND", `no locked Toolkit adapter exposes ${operationId}`, {
        retryable: false
      });
    }
    return delegate.execute(operationId, input, deadline, trace);
  }

  async readiness(): Promise<H3ToolkitReadiness> {
    const results = await Promise.all(this.delegates.map((delegate) => delegate.readiness()));
    const reasons = results.flatMap((result) => result.reasons);
    return {
      ready: reasons.length === 0,
      reasons,
      sourceGitCommit: this.attestation.sourceGitCommit,
      toolkitVersion: this.attestation.toolkitVersion,
      engineVersion: this.attestation.engineVersion
    };
  }
}
