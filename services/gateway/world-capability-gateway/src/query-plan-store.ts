import type {
  GowmV071QuerySnapshotManifest as QuerySnapshotManifest,
  JobRecord,
  WorldQueryResultNodeResult,
  WorldQuerySubmission
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { compareUnicodeCodePoints } from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { GatewayPrincipal } from "./types.js";
import { principalContextHash } from "./principal-context.js";

export interface QueryJobContext {
  job: JobRecord;
  submission: WorldQuerySubmission;
  principal: GatewayPrincipal;
  requestHash: `sha256:${string}`;
  cancellationRequested: boolean;
  /** Internal PostgreSQL Gateway Job identity; never accepted from a public request. */
  gatewayJobId?: string;
  executionFence?: QueryExecutionFence;
  requestedSnapshotManifest: QuerySnapshotManifest;
  effectiveSnapshotManifest: QuerySnapshotManifest;
  effectiveSnapshotRevision: number;
  /** @deprecated Accepted only at legacy construction boundaries. */
  snapshotManifest?: QuerySnapshotManifest;
}

export interface QueryExecutionFence {
  leaseOwner: string;
  attempt: number;
}

export interface QueryJobCreateResult {
  context: QueryJobContext;
  replayed: boolean;
}

export interface QueryPlanStore {
  create(context: QueryJobContext): Promise<QueryJobCreateResult>;
  updateJob(job: JobRecord, fence?: QueryExecutionFence): Promise<void>;
  getByQueryId(queryId: string): Promise<QueryJobContext | undefined>;
  getByJobId(jobId: string): Promise<QueryJobContext | undefined>;
  getByQueryIdForPrincipal(queryId: string, principalHash: string): Promise<QueryJobContext | undefined>;
  getByJobIdForPrincipal(jobId: string, principalHash: string): Promise<QueryJobContext | undefined>;
  putNode(jobId: string, node: WorldQueryResultNodeResult, fence?: QueryExecutionFence): Promise<void>;
  commitNodeResult(
    jobId: string,
    node: WorldQueryResultNodeResult,
    snapshotUpdate?: {
      expectedManifestHash: QuerySnapshotManifest["manifestHash"];
      nextEffectiveManifest: QuerySnapshotManifest;
    },
    fence?: QueryExecutionFence
  ): Promise<void>;
  listNodes(jobId: string): Promise<WorldQueryResultNodeResult[]>;
  requestCancellation(queryId: string, principalHash: string): Promise<QueryJobContext | undefined>;
  cancellationRequested(jobId: string): Promise<boolean>;
}

export class MemoryQueryPlanStore implements QueryPlanStore {
  readonly #byJob = new Map<string, QueryJobContext>();
  readonly #jobByQuery = new Map<string, string>();
  readonly #idempotency = new Map<string, string>();
  readonly #nodes = new Map<string, Map<string, WorldQueryResultNodeResult>>();

  async create(context: QueryJobContext): Promise<QueryJobCreateResult> {
    const canonical = canonicalContext(context);
    const principalHash = principalContextHash(canonical.principal);
    const key = `${principalHash}:${canonical.submission.idempotencyKey}`;
    const existingJobId = this.#idempotency.get(key);
    if (existingJobId) {
      const existing = this.#byJob.get(existingJobId);
      if (!existing) throw new Error("query idempotency index is inconsistent");
      if (existing.requestHash !== canonical.requestHash) {
        throw new ProviderProtocolError("IDEMPOTENCY_CONFLICT", "world query idempotency key was reused with a different request");
      }
      return { context: clone(existing), replayed: true };
    }
    if (this.#jobByQuery.has(canonical.submission.plan.queryId)) {
      throw new ProviderProtocolError("IDEMPOTENCY_CONFLICT", "world query id is already registered");
    }
    const stored = clone(canonical);
    this.#byJob.set(canonical.job.jobId, stored);
    this.#jobByQuery.set(canonical.submission.plan.queryId, canonical.job.jobId);
    this.#idempotency.set(key, canonical.job.jobId);
    this.#nodes.set(canonical.job.jobId, new Map(canonical.submission.plan.nodes.map((node) => [
      node.nodeId,
      { nodeId: node.nodeId, operation: structuredClone(node.operation), status: "QUEUED", attempt: 0 }
    ])));
    return { context: clone(stored), replayed: false };
  }

  async updateJob(job: JobRecord, fence?: QueryExecutionFence): Promise<void> {
    const existing = this.#byJob.get(job.jobId);
    if (!existing) throw new Error(`query job ${job.jobId} is not registered`);
    assertFence(existing.executionFence, fence);
    if (terminalJobStatus(existing.job.status) && existing.job.status !== job.status) {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "world query terminal state cannot regress", { retryable: false });
    }
    this.#byJob.set(job.jobId, { ...existing, job: clone(job) });
  }

  async getByQueryId(queryId: string): Promise<QueryJobContext | undefined> {
    const jobId = this.#jobByQuery.get(queryId);
    if (!jobId) return undefined;
    const context = this.#byJob.get(jobId);
    return context === undefined ? undefined : clone(context);
  }

  async getByJobId(jobId: string): Promise<QueryJobContext | undefined> {
    const context = this.#byJob.get(jobId);
    return context === undefined ? undefined : clone(context);
  }

  async getByQueryIdForPrincipal(queryId: string, principalHash: string): Promise<QueryJobContext | undefined> {
    const context = await this.getByQueryId(queryId);
    return context !== undefined && principalContextHash(context.principal) === principalHash ? context : undefined;
  }

  async getByJobIdForPrincipal(jobId: string, principalHash: string): Promise<QueryJobContext | undefined> {
    const context = await this.getByJobId(jobId);
    return context !== undefined && principalContextHash(context.principal) === principalHash ? context : undefined;
  }

  async putNode(jobId: string, node: WorldQueryResultNodeResult, fence?: QueryExecutionFence): Promise<void> {
    await this.commitNodeResult(jobId, node, undefined, fence);
  }

  async commitNodeResult(
    jobId: string,
    node: WorldQueryResultNodeResult,
    snapshotUpdate?: {
      expectedManifestHash: QuerySnapshotManifest["manifestHash"];
      nextEffectiveManifest: QuerySnapshotManifest;
    },
    fence?: QueryExecutionFence
  ): Promise<void> {
    const context = this.#byJob.get(jobId);
    if (!context) throw new Error(`query job ${jobId} is not registered`);
    assertFence(context.executionFence, fence);
    const nodes = this.#nodes.get(jobId);
    if (!nodes) throw new Error(`query job ${jobId} is not registered`);
    // Prepare every value before mutating either map so structured-clone failures
    // cannot leave a snapshot revision without its corresponding node result.
    const nextNode = clone(node);
    const nextEffectiveManifest = snapshotUpdate === undefined
      ? undefined
      : clone(snapshotUpdate.nextEffectiveManifest);
    if (snapshotUpdate !== undefined) {
      if (context.effectiveSnapshotManifest.manifestHash !== snapshotUpdate.expectedManifestHash) {
        throw new ProviderProtocolError("PROVIDER_NOT_READY", "effective snapshot compare-and-swap failed", {
          retryable: true,
          details: { stage: "EXECUTION_FENCE" }
        });
      }
      context.effectiveSnapshotManifest = nextEffectiveManifest!;
      context.effectiveSnapshotRevision += 1;
    }
    nodes.set(node.nodeId, nextNode);
  }

  async listNodes(jobId: string): Promise<WorldQueryResultNodeResult[]> {
    return [...(this.#nodes.get(jobId)?.values() ?? [])]
      .map(clone)
      .sort((left, right) => compareUnicodeCodePoints(left.nodeId, right.nodeId));
  }

  async requestCancellation(queryId: string, principalHash: string): Promise<QueryJobContext | undefined> {
    const context = await this.getByQueryIdForPrincipal(queryId, principalHash);
    if (!context) return undefined;
    const stored = this.#byJob.get(context.job.jobId);
    if (!stored) return undefined;
    stored.cancellationRequested = true;
    return clone(stored);
  }

  async cancellationRequested(jobId: string): Promise<boolean> {
    return this.#byJob.get(jobId)?.cancellationRequested ?? false;
  }

  /** Controlled test/runtime-double hook that models a PostgreSQL lease recovery. */
  assignExecutionFence(jobId: string, leaseOwner: string): QueryExecutionFence {
    const context = this.#byJob.get(jobId);
    if (!context) throw new Error(`query job ${jobId} is not registered`);
    const fence = { leaseOwner, attempt: (context.executionFence?.attempt ?? 0) + 1 };
    context.executionFence = fence;
    return clone(fence);
  }
}

function assertFence(expected: QueryExecutionFence | undefined, supplied: QueryExecutionFence | undefined): void {
  if (expected === undefined && supplied === undefined) return;
  if (
    expected === undefined || supplied === undefined ||
    expected.leaseOwner !== supplied.leaseOwner || expected.attempt !== supplied.attempt
  ) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "world query execution lease was superseded", {
      retryable: false,
      details: { stage: "EXECUTION_FENCE" }
    });
  }
}

function terminalJobStatus(status: JobRecord["status"]): boolean {
  return ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(status);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalContext(context: QueryJobContext): QueryJobContext {
  const requested = context.requestedSnapshotManifest ?? context.snapshotManifest;
  const effective = context.effectiveSnapshotManifest ?? requested;
  if (requested === undefined || effective === undefined) {
    throw new TypeError("query job context requires requested and effective snapshots");
  }
  const { snapshotManifest: _legacySnapshot, ...canonical } = clone(context);
  return {
    ...canonical,
    requestedSnapshotManifest: clone(requested),
    effectiveSnapshotManifest: clone(effective),
    effectiveSnapshotRevision: context.effectiveSnapshotRevision ?? 0
  };
}
