import type {
  CapabilityDescriptor,
  CapabilityResultEnvelope,
  GatewayExecuteRequest,
  JobRecord,
  PlatformError,
  WorldQueryPlanV2InputBinding,
  WorldQueryPlanV2Node,
  WorldQueryPlanV2SchemaPort,
  WorldQueryResult,
  WorldQueryResultNodeResult,
  WorldQuerySubmission
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { isDeepStrictEqual } from "node:util";
import {
  getContractSchema,
  getContractSchemaHash,
  isContractSchemaHash,
  validateAgainstSchema,
  validateContract
} from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  byteLength,
  mapProviderError,
  newOpaqueId,
  ProviderProtocolError,
  sha256
} from "../../../../packages/platform/provider-sdk/src/index.js";
import type { DirectExecutionService } from "./direct-execution.js";
import { QueryPlanValidator } from "./query-plan-validation.js";
import type { QueryJobContext, QueryPlanStore } from "./query-plan-store.js";
import type { GatewayPrincipal, ResolvedCapability } from "./types.js";
import { publicErrorMessage, redactPublicDetails } from "./redaction.js";
import { principalContextHash } from "./principal-context.js";

export type WorldQueryExecutionMode = "SYNC" | "ASYNC";

export interface WorldQuerySubmitResult {
  job: JobRecord;
  result?: WorldQueryResult;
  replayed: boolean;
}

export interface WorldQueryRuntimeOptions {
  validator: QueryPlanValidator;
  directExecution: DirectExecutionService;
  store: QueryPlanStore;
  now?: () => Date;
  autoRunAsync?: boolean;
}

export class WorldQueryRuntime {
  readonly #now: () => Date;
  readonly #autoRunAsync: boolean;
  readonly #running = new Map<string, Promise<WorldQueryResult>>();

  constructor(private readonly options: WorldQueryRuntimeOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#autoRunAsync = options.autoRunAsync ?? true;
  }

  async submit(
    submission: WorldQuerySubmission,
    principal: GatewayPrincipal,
    mode: WorldQueryExecutionMode = "SYNC"
  ): Promise<WorldQuerySubmitResult> {
    this.#assertParameterContract(submission);
    const validated = this.options.validator.validate(submission, principal);
    const now = this.#now().toISOString();
    const job: JobRecord = {
      jobId: newOpaqueId("query_job"),
      requestId: submission.requestId,
      kind: "WORLD_QUERY",
      status: mode === "SYNC" ? "RUNNING" : "QUEUED",
      queryId: submission.plan.queryId,
      createdAt: now,
      updatedAt: now,
      ...(mode === "SYNC" ? { startedAt: now } : {})
    };
    const created = await this.options.store.create({
      job,
      submission: structuredClone(submission),
      principal: structuredClone(principal),
      requestHash: sha256(submission),
      cancellationRequested: false
    });
    if (created.replayed) {
      return {
        job: created.context.job,
        ...(isWorldQueryResult(created.context.job.result) ? { result: created.context.job.result } : {}),
        replayed: true
      };
    }
    if (mode === "ASYNC") {
      if (this.#autoRunAsync) queueMicrotask(() => {
        void this.run(job.jobId).catch(() => undefined);
      });
      return { job, replayed: false };
    }
    const result = await this.run(job.jobId);
    const completed = await this.options.store.getByJobId(job.jobId);
    if (!completed) throw new Error("completed query job disappeared");
    return { job: completed.job, result, replayed: false };
  }

  async run(jobId: string): Promise<WorldQueryResult> {
    const existing = this.#running.get(jobId);
    if (existing) return existing;
    const execution = this.#execute(jobId)
      .catch(async (error: unknown) => {
        await this.#markJobFailed(jobId, error);
        throw error;
      })
      .finally(() => this.#running.delete(jobId));
    this.#running.set(jobId, execution);
    return execution;
  }

  async get(queryId: string, principal: GatewayPrincipal): Promise<JobRecord | undefined> {
    return (await this.options.store.getByQueryIdForPrincipal(queryId, principalContextHash(principal)))?.job;
  }

  async getJob(jobId: string, principal: GatewayPrincipal): Promise<JobRecord | undefined> {
    return (await this.options.store.getByJobIdForPrincipal(jobId, principalContextHash(principal)))?.job;
  }

  async cancel(queryId: string, principal: GatewayPrincipal): Promise<JobRecord | undefined> {
    const context = await this.options.store.requestCancellation(queryId, principalContextHash(principal));
    if (!context) return undefined;
    if (context.job.status === "QUEUED") {
      const now = this.#now().toISOString();
      const job: JobRecord = {
        ...context.job,
        status: "CANCELLED",
        updatedAt: now,
        finishedAt: now
      };
      await this.options.store.updateJob(job);
      return job;
    }
    return context.job;
  }

  async #markJobFailed(jobId: string, error: unknown): Promise<void> {
    const context = await this.options.store.getByJobId(jobId);
    if (!context || ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(context.job.status)) return;
    const mapped = mapProviderError(error);
    const now = this.#now().toISOString();
    await this.options.store.updateJob({
      ...context.job,
      status: "FAILED",
      updatedAt: now,
      finishedAt: now,
      error: platformError(
        context.job.requestId,
        mapped.code,
        publicErrorMessage(mapped.code),
        mapped.retryable,
        undefined,
        undefined,
        redactPublicDetails(mapped.details)
      )
    });
  }

  async #execute(jobId: string): Promise<WorldQueryResult> {
    const context = await this.options.store.getByJobId(jobId);
    if (!context) throw new ProviderProtocolError("INVALID_REQUEST", `world query job ${jobId} is not registered`);
    if (isWorldQueryResult(context.job.result)) return context.job.result;
    if (context.job.status === "CANCELLED") {
      const result = this.#cancelledResult(context);
      await this.options.store.updateJob({ ...context.job, result });
      return result;
    }

    const deadline = Date.parse(context.job.createdAt) + context.submission.plan.budgets.maximumExecutionMs;
    if (this.#now().getTime() >= deadline) {
      throw new ProviderProtocolError("DEADLINE_EXCEEDED", "world query deadline elapsed while queued");
    }
    const validated = this.options.validator.validate(context.submission, context.principal);
    const startedAt = context.job.startedAt ?? this.#now().toISOString();
    const runningJob: JobRecord = {
      ...context.job,
      status: "RUNNING",
      startedAt,
      updatedAt: this.#now().toISOString()
    };
    await this.options.store.updateJob(runningJob);

    const nodeResults = new Map(
      (await this.options.store.listNodes(jobId)).map((node) => [node.nodeId, node])
    );
    const warnings: string[] = [];
    let failFast = false;

    for (const node of validated.orderedNodes) {
      const prior = nodeResults.get(node.nodeId);
      if (prior && terminalNodeStatus(prior.status) && prior.status !== "QUEUED") continue;
      if (await this.options.store.cancellationRequested(jobId)) break;
      if (failFast) {
        const skipped = skippedNode(node, "Skipped after an upstream FAIL_FAST error", this.#now().toISOString());
        nodeResults.set(node.nodeId, skipped);
        await this.options.store.putNode(jobId, skipped);
        continue;
      }
      if (!this.#preconditionsMet(node, context.submission.parameters, nodeResults, validated.routes)) {
        const skipped = skippedNode(node, "Node precondition evaluated false", this.#now().toISOString());
        nodeResults.set(node.nodeId, skipped);
        await this.options.store.putNode(jobId, skipped);
        warnings.push(`${node.nodeId}: precondition false`);
        continue;
      }

      const route = validated.routes.get(node.nodeId);
      if (!route) throw new Error(`validated route for ${node.nodeId} disappeared`);
      let runningNode: WorldQueryResultNodeResult | undefined;
      try {
        if (this.#now().getTime() >= deadline) {
          throw new ProviderProtocolError("DEADLINE_EXCEEDED", "world query plan deadline elapsed");
        }
        const input = this.#resolveNodeInput(node, route.descriptor, context.submission.parameters, nodeResults, validated.routes);
        this.#assertValue(route.descriptor.inputSchemaUri, route.descriptor.inputSchemaHash, input, node.nodeId, "input");
        const inputHash = sha256(input);
        const nodeStartedAt = this.#now().toISOString();
        const running = {
          ...queuedNode(node),
          status: "RUNNING" as const,
          attempt: (prior?.attempt ?? 0) + 1,
          providerId: route.manifest.provider.providerId,
          startedAt: nodeStartedAt,
          inputHash
        };
        nodeResults.set(node.nodeId, running);
        runningNode = running;
        await this.options.store.putNode(jobId, running);

        const nodeDeadlineMs = Math.min(
          deadline,
          this.#now().getTime() + node.budget.maximumExecutionMs,
          this.#now().getTime() + route.descriptor.execution.maximumTimeoutMs
        );
        const request: GatewayExecuteRequest = {
          requestVersion: "1.0",
          requestId: newOpaqueId("query_node"),
          idempotencyKey: nodeIdempotencyKey(context.submission.idempotencyKey, node.nodeId, inputHash),
          operationVersion: node.operation.operationVersion,
          inputSchemaHash: node.operation.inputSchemaHash,
          outputSchemaHash: node.operation.outputSchemaHash,
          input,
          executionPolicy: {
            deadlineAt: new Date(nodeDeadlineMs).toISOString(),
            maximumResultBytes: node.budget.maximumOutputBytes,
            ...(route.descriptor.limits.maximumRows === undefined
              ? {}
              : { maximumRows: node.budget.maximumRows }),
            ...(route.descriptor.limits.maximumCandidates === undefined
              ? {}
              : { maximumCandidates: node.budget.maximumCandidates }),
            maximumCostClass: route.descriptor.execution.costClass,
            preferredExecution: "SYNC"
          }
        };
        const executed = await this.options.directExecution.execute(
          node.operation.operationId,
          request,
          context.principal
        );
        if (await this.options.store.cancellationRequested(jobId)) {
          const cancelled = cancelledNode(node, this.#now().toISOString(), running.attempt);
          nodeResults.set(node.nodeId, cancelled);
          await this.options.store.putNode(jobId, cancelled);
          break;
        }
        const envelope = executed.result;
        if (envelope.output !== undefined) {
          this.#assertValue(
            route.descriptor.outputSchemaUri,
            route.descriptor.outputSchemaHash,
            envelope.output.value,
            node.nodeId,
            "output"
          );
        }
        if (byteLength(envelope) > node.budget.maximumOutputBytes) {
          throw new ProviderProtocolError("BUDGET_EXCEEDED", "DAG node result exceeds its output budget");
        }
        const status = nodeStatusFor(envelope);
        const finishedAt = this.#now().toISOString();
        const completed: WorldQueryResultNodeResult = {
          nodeId: node.nodeId,
          operation: node.operation,
          providerId: route.manifest.provider.providerId,
          status,
          attempt: running.attempt,
          startedAt: nodeStartedAt,
          finishedAt,
          inputHash,
          outputHash: sha256(envelope),
          result: envelope,
          ...(envelope.error === undefined ? {} : { error: withNodeIdentity(envelope.error, node.nodeId, route.manifest.provider.providerId) })
        };
        nodeResults.set(node.nodeId, completed);
        await this.options.store.putNode(jobId, completed);
        warnings.push(...envelope.warnings.map((warning) => `${node.nodeId}: ${warning}`));
        if (status === "FAILED") {
          warnings.push(`${node.nodeId}: provider returned ${envelope.status}`);
          failFast = node.failurePolicy === "FAIL_FAST";
        }
      } catch (error) {
        if (await this.options.store.cancellationRequested(jobId)) {
          const cancelled = cancelledNode(
            node,
            this.#now().toISOString(),
            runningNode?.attempt ?? prior?.attempt ?? 0
          );
          nodeResults.set(node.nodeId, cancelled);
          await this.options.store.putNode(jobId, cancelled);
          break;
        }
        const mapped = mapProviderError(error);
        const failed = failedNode(node, route, mapped, runningNode ?? prior, this.#now().toISOString());
        nodeResults.set(node.nodeId, failed);
        await this.options.store.putNode(jobId, failed);
        warnings.push(`${node.nodeId}: ${mapped.code}`);
        failFast = node.failurePolicy === "FAIL_FAST";
      }
    }

    if (await this.options.store.cancellationRequested(jobId)) {
      for (const node of validated.orderedNodes) {
        const value = nodeResults.get(node.nodeId);
        if (!value || ["QUEUED", "RUNNING"].includes(value.status)) {
          const cancelled = cancelledNode(node, this.#now().toISOString(), value?.attempt ?? 0);
          nodeResults.set(node.nodeId, cancelled);
          await this.options.store.putNode(jobId, cancelled);
        }
      }
    }

    const orderedResults = context.submission.plan.nodes.map((node) =>
      nodeResults.get(node.nodeId) ?? queuedNode(node)
    );
    const cancelled = orderedResults.some((node) => node.status === "CANCELLED");
    const failed = orderedResults.some((node) => node.status === "FAILED");
    const partial = orderedResults.some((node) => ["PARTIAL", "NO_DATA", "SKIPPED"].includes(node.status));
    const outputs = this.#assembleOutputs(context.submission, nodeResults, validated.routes, warnings);
    const finishedAt = this.#now().toISOString();
    const status: WorldQueryResult["status"] = cancelled
      ? "CANCELLED"
      : failed && failFast
        ? "FAILED"
        : failed || partial
          ? "PARTIAL"
          : "COMPLETED";
    const result: WorldQueryResult = {
      queryPlanVersion: "2.0",
      queryId: context.submission.plan.queryId,
      jobId,
      status,
      nodes: orderedResults,
      outputs,
      warnings,
      startedAt,
      finishedAt,
      outputHash: sha256(outputs)
    };
    if (byteLength(result) > context.submission.plan.budgets.maximumOutputBytes) {
      throw new ProviderProtocolError("BUDGET_EXCEEDED", "world query result exceeds the aggregate output budget", {
        details: { stage: "RESULT_ASSEMBLY", jobId }
      });
    }
    const resultValidation = validateContract("world-query-result.schema.json", result);
    if (!resultValidation.valid) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "world query result violates its canonical contract", {
        details: { stage: "RESULT_ASSEMBLY", jobId, issues: resultValidation.issues }
      });
    }
    const terminalJob: JobRecord = {
      ...runningJob,
      status,
      updatedAt: finishedAt,
      finishedAt,
      result,
      ...(status === "FAILED"
        ? { error: firstNodeError(orderedResults) ?? platformError(context.job.requestId, "WORLD_QUERY_FAILED", "World query failed", false) }
        : {})
    };
    await this.options.store.updateJob(terminalJob);
    return result;
  }

  #assertParameterContract(submission: WorldQuerySubmission): void {
    const expected = getContractSchemaHash("world-query-parameters.schema.json");
    if (submission.parameterSchemaHash !== expected) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "world query parameter schema hash is not registered", {
        details: { stage: "DAG_VALIDATION", expected, actual: submission.parameterSchemaHash }
      });
    }
    const validation = validateContract("world-query-parameters.schema.json", submission.parameters);
    if (!validation.valid) {
      throw new ProviderProtocolError("INVALID_REQUEST", "world query parameters violate their schema", {
        details: { stage: "DAG_VALIDATION", issues: validation.issues }
      });
    }
  }

  #preconditionsMet(
    node: WorldQueryPlanV2Node,
    parameters: Record<string, unknown>,
    results: ReadonlyMap<string, WorldQueryResultNodeResult>,
    routes: ReadonlyMap<string, ResolvedCapability>
  ): boolean {
    for (const precondition of node.preconditions ?? []) {
      if (precondition.kind === "NODE_STATUS") {
        const status = results.get(precondition.nodeId)?.status;
        if (!status || !precondition.statuses.includes(status as "COMPLETED" | "PARTIAL" | "NO_DATA")) return false;
      } else if (precondition.kind === "VALUE_PRESENT") {
        try {
          const value = this.#resolveBinding(precondition.binding, parameters, results, routes);
          if (value === undefined || value === null) return false;
        } catch {
          return false;
        }
      } else {
        try {
          const value = this.#resolveBinding(precondition.binding, parameters, results, routes);
          if (!isDeepStrictEqual(value, precondition.value)) return false;
        } catch {
          return false;
        }
      }
    }
    return true;
  }

  #resolveNodeInput(
    node: WorldQueryPlanV2Node,
    descriptor: CapabilityDescriptor,
    parameters: Record<string, unknown>,
    results: ReadonlyMap<string, WorldQueryResultNodeResult>,
    routes: ReadonlyMap<string, ResolvedCapability>
  ): unknown {
    const entries = Object.entries(node.inputs);
    const resolved = entries.map(([name, binding]) => {
      const value = this.#resolveBinding(binding, parameters, results, routes);
      this.#assertPortValue(binding.port, value, node.nodeId, name);
      return { name, binding, value };
    });
    const wholeRequestBinding =
      resolved.length === 1 &&
      resolved[0]?.name === "request" &&
      resolved[0].binding.targetPath === undefined &&
      descriptor.ports.inputs.length === 1 &&
      descriptor.ports.inputs[0]?.name === "request";
    if (wholeRequestBinding) return resolved[0]!.value;
    const request = Object.create(null) as Record<string, unknown>;
    for (const { name, binding, value } of resolved) {
      assignTargetValue(request, binding.targetPath ?? `/${escapePointerSegment(name)}`, value);
    }
    return request;
  }

  #resolveBinding(
    binding: WorldQueryPlanV2InputBinding,
    parameters: Record<string, unknown>,
    results: ReadonlyMap<string, WorldQueryResultNodeResult>,
    routes: ReadonlyMap<string, ResolvedCapability>
  ): unknown {
    switch (binding.kind) {
      case "LITERAL":
        return structuredClone(binding.value);
      case "REQUEST_PATH":
        return pointer(parameters, binding.path);
      case "REFERENCE_KEY":
        return structuredClone(binding.referenceKey);
      case "DATASET_VERSION":
        return { datasetId: binding.datasetId, version: binding.version };
      case "ARTIFACT_REFERENCE":
        return { artifactId: binding.artifactId, digest: binding.digest };
      case "NODE_OUTPUT": {
        const source = results.get(binding.nodeId);
        if (!source?.result || !["COMPLETED", "PARTIAL", "NO_DATA"].includes(source.status)) {
          throw new ProviderProtocolError("INVALID_REQUEST", "required upstream node output is unavailable", {
            details: { stage: "DAG_EXECUTION", sourceNodeId: binding.nodeId, sourceStatus: source?.status ?? "MISSING" }
          });
        }
        const route = routes.get(binding.nodeId);
        if (!route) throw new Error(`route for ${binding.nodeId} disappeared`);
        return outputPortValue(source.result, route, binding.outputPort);
      }
    }
  }

  #assertPortValue(port: WorldQueryPlanV2SchemaPort, value: unknown, nodeId: string, portName: string): void {
    this.#assertValue(port.schemaUri, port.schemaHash, value, nodeId, portName);
  }

  #assertValue(
    schemaUri: string,
    schemaHash: string,
    value: unknown,
    nodeId: string,
    role: string
  ): void {
    const canonicalHash = getContractSchemaHash(schemaUri);
    if (!isContractSchemaHash(schemaUri, schemaHash)) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "DAG value schema attestation is stale", {
        details: { stage: "DAG_EXECUTION", nodeId, role, schemaUri, canonicalHash, schemaHash }
      });
    }
    const validation = validateAgainstSchema(getContractSchema(schemaUri), value, { schemaName: schemaUri });
    if (!validation.valid) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "DAG value does not match its typed port", {
        details: { stage: "DAG_EXECUTION", nodeId, role, issues: validation.issues }
      });
    }
  }

  #assembleOutputs(
    submission: WorldQuerySubmission,
    results: ReadonlyMap<string, WorldQueryResultNodeResult>,
    routes: ReadonlyMap<string, ResolvedCapability>,
    warnings: string[]
  ): Record<string, unknown> {
    const outputs: Record<string, unknown> = {};
    for (const output of submission.plan.outputs) {
      try {
        const value = this.#resolveBinding(output.binding, submission.parameters, results, routes);
        this.#assertPortValue(output.binding.port, value, output.binding.nodeId, output.name);
        outputs[output.name] = value;
      } catch (error) {
        warnings.push(`${output.name}: output unavailable (${mapProviderError(error).code})`);
      }
    }
    return outputs;
  }

  #cancelledResult(context: QueryJobContext): WorldQueryResult {
    const finishedAt = context.job.finishedAt ?? this.#now().toISOString();
    return {
      queryPlanVersion: "2.0",
      queryId: context.submission.plan.queryId,
      jobId: context.job.jobId,
      status: "CANCELLED",
      nodes: context.submission.plan.nodes.map((node) => cancelledNode(node, finishedAt, 0)),
      outputs: {},
      warnings: ["Query was cancelled before execution"],
      startedAt: context.job.startedAt ?? context.job.createdAt,
      finishedAt,
      outputHash: sha256({})
    };
  }
}

function queuedNode(node: WorldQueryPlanV2Node): WorldQueryResultNodeResult {
  return { nodeId: node.nodeId, operation: node.operation, status: "QUEUED", attempt: 0 };
}

function skippedNode(node: WorldQueryPlanV2Node, message: string, finishedAt: string): WorldQueryResultNodeResult {
  return {
    nodeId: node.nodeId,
    operation: node.operation,
    status: "SKIPPED",
    attempt: 0,
    finishedAt,
    error: platformError(newOpaqueId("query_node"), "NODE_SKIPPED", message, false, node.nodeId)
  };
}

function cancelledNode(node: WorldQueryPlanV2Node, finishedAt: string, attempt: number): WorldQueryResultNodeResult {
  return {
    nodeId: node.nodeId,
    operation: node.operation,
    status: "CANCELLED",
    attempt,
    finishedAt,
    error: platformError(newOpaqueId("query_node"), "NODE_CANCELLED", "Node execution was cancelled", false, node.nodeId)
  };
}

function failedNode(
  node: WorldQueryPlanV2Node,
  route: ResolvedCapability,
  error: ProviderProtocolError,
  previous: WorldQueryResultNodeResult | undefined,
  finishedAt: string
): WorldQueryResultNodeResult {
  return {
    nodeId: node.nodeId,
    operation: node.operation,
    providerId: route.manifest.provider.providerId,
    status: "FAILED",
    attempt: previous?.status === "RUNNING" ? previous.attempt : (previous?.attempt ?? 0) + 1,
    ...(previous?.startedAt === undefined ? {} : { startedAt: previous.startedAt }),
    finishedAt,
    ...(previous?.inputHash === undefined ? {} : { inputHash: previous.inputHash }),
    error: platformError(
      newOpaqueId("query_node"),
      error.code,
      publicErrorMessage(error.code),
      error.retryable,
      node.nodeId,
      route.manifest.provider.providerId,
      redactPublicDetails(error.details)
    )
  };
}

function nodeStatusFor(result: CapabilityResultEnvelope): WorldQueryResultNodeResult["status"] {
  if (result.status === "COMPLETED") return "COMPLETED";
  if (result.status === "PARTIAL") return "PARTIAL";
  if (result.status === "NO_DATA") return "NO_DATA";
  return "FAILED";
}

function terminalNodeStatus(status: WorldQueryResultNodeResult["status"]): boolean {
  return !["QUEUED", "RUNNING"].includes(status);
}

function outputPortValue(result: CapabilityResultEnvelope, route: ResolvedCapability, portName: string): unknown {
  const port = route.descriptor.ports.outputs.find((candidate) => candidate.name === portName);
  if (!port) throw new ProviderProtocolError("SCHEMA_MISMATCH", `Provider output port ${portName} is not registered`);
  const value = result.output?.value;
  return port.path === undefined ? value : pointer(value, port.path);
}

function pointer(value: unknown, path: string): unknown {
  let current = value;
  for (const raw of path.slice(1).split("/")) {
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    const normalized = part.toLowerCase();
    if (UNSAFE_TARGET_SEGMENTS.has(normalized) || RESERVED_TARGET_SECURITY_SEGMENTS.has(normalized)) {
      throw new ProviderProtocolError("INVALID_REQUEST", "unsafe JSON Pointer segment in DAG binding");
    }
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(part)) throw new ProviderProtocolError("INVALID_REQUEST", "DAG array pointer is invalid");
      current = current[Number(part)];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, part)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      throw new ProviderProtocolError("INVALID_REQUEST", "DAG binding path does not exist");
    }
  }
  return current;
}

const TARGET_POINTER = /^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/u;
const MAX_TARGET_PATH_DEPTH = 8;
const UNSAFE_TARGET_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const RESERVED_TARGET_SECURITY_SEGMENTS = new Set([
  "securitycontext",
  "principalref",
  "authenticationmethod",
  "scopeattestation",
  "datascopeclaim",
  "datasetscopeclaim",
  "gatewaycontext",
  "gatewayid",
  "allowexperimental"
]);

function assignTargetValue(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!TARGET_POINTER.test(path)) {
    throw new ProviderProtocolError("INVALID_REQUEST", "DAG targetPath is not a rooted JSON Pointer");
  }
  const segments = path.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (segments.length > MAX_TARGET_PATH_DEPTH) {
    throw new ProviderProtocolError("INVALID_REQUEST", "DAG targetPath exceeds the bounded object depth");
  }
  if (segments.some((segment) => {
    const normalized = segment.toLowerCase();
    return UNSAFE_TARGET_SEGMENTS.has(normalized) || RESERVED_TARGET_SECURITY_SEGMENTS.has(normalized);
  })) {
    throw new ProviderProtocolError("INVALID_REQUEST", "unsafe JSON Pointer segment in DAG targetPath");
  }
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (!Object.hasOwn(current, segment)) {
      current[segment] = Object.create(null) as Record<string, unknown>;
    }
    const child = current[segment];
    if (child === null || typeof child !== "object" || Array.isArray(child)) {
      throw new ProviderProtocolError("INVALID_REQUEST", "DAG targetPath collides with a non-object value");
    }
    current = child as Record<string, unknown>;
  }
  const leaf = segments.at(-1)!;
  if (Object.hasOwn(current, leaf)) {
    throw new ProviderProtocolError("INVALID_REQUEST", "DAG targetPath assigns the same request field more than once");
  }
  current[leaf] = value;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function nodeIdempotencyKey(base: string, nodeId: string, inputHash: string): string {
  const candidate = `${base}:${nodeId}:${inputHash}`;
  return candidate.length <= 256 ? candidate : `dag:${sha256({ base, nodeId, inputHash }).slice("sha256:".length)}`;
}

function platformError(
  requestId: string,
  code: string,
  message: string,
  retryable: boolean,
  nodeId?: string,
  providerId?: string,
  details?: Readonly<Record<string, unknown>>
): PlatformError {
  return {
    schemaVersion: "1.0",
    requestId,
    error: {
      code,
      message,
      retryable,
      stage: "DAG_EXECUTION",
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(providerId === undefined ? {} : { providerId }),
      ...(details === undefined ? {} : { details: { ...details } })
    }
  };
}

function withNodeIdentity(error: PlatformError, nodeId: string, providerId: string): PlatformError {
  const details = redactPublicDetails(error.error.details);
  return {
    ...structuredClone(error),
    error: {
      code: error.error.code,
      message: publicErrorMessage(error.error.code),
      retryable: error.error.retryable,
      nodeId,
      providerId,
      stage: "DAG_EXECUTION",
      ...(details === undefined ? {} : { details })
    }
  };
}

function firstNodeError(nodes: readonly WorldQueryResultNodeResult[]): PlatformError | undefined {
  return nodes.find((node) => node.error)?.error;
}

function isWorldQueryResult(value: unknown): value is WorldQueryResult {
  return value !== null && typeof value === "object" && (value as { queryPlanVersion?: unknown }).queryPlanVersion === "2.0";
}
