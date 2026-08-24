import type {
  CapabilityDescriptor,
  WorldQueryPlanV2InputBinding,
  WorldQueryPlanV2Node,
  WorldQueryPlanV2SchemaPort,
  WorldQuerySubmission
} from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  getContractSchemaHash,
  validateContract,
  validateWorldQueryPlanSemantics
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError } from "../../../../packages/platform/provider-sdk/src/index.js";
import { CapabilityRegistry } from "./registry.js";
import type { GatewayPrincipal, ResolvedCapability } from "./types.js";

type NodeOutputBinding = Extract<WorldQueryPlanV2InputBinding, { kind: "NODE_OUTPUT" }>;

export interface QueryPlanPolicy {
  maximumNodes: number;
  maximumDepth: number;
  maximumRows: number;
  maximumCandidates: number;
  maximumOutputBytes: number;
  maximumExecutionMs: number;
}

export const DEFAULT_QUERY_PLAN_POLICY: Readonly<QueryPlanPolicy> = Object.freeze({
  maximumNodes: 64,
  maximumDepth: 32,
  maximumRows: 1_000_000,
  maximumCandidates: 5_000_000,
  maximumOutputBytes: 128_000_000,
  maximumExecutionMs: 300_000
});

export interface ValidatedQueryPlan {
  submission: WorldQuerySubmission;
  orderedNodes: WorldQueryPlanV2Node[];
  routes: ReadonlyMap<string, ResolvedCapability>;
  dependencies: ReadonlyMap<string, ReadonlySet<string>>;
}

const RESERVED_SECURITY_KEYS = new Set([
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
const MAX_TARGET_PATH_DEPTH = 8;
const UNSAFE_TARGET_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export class QueryPlanValidator {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly policy: Readonly<QueryPlanPolicy> = DEFAULT_QUERY_PLAN_POLICY
  ) {}

  validate(submission: WorldQuerySubmission, principal: GatewayPrincipal): ValidatedQueryPlan {
    const contract = validateContract("world-query-submission.schema.json", submission);
    if (!contract.valid) this.fail("World query submission does not match the canonical contract", {
      issues: contract.issues
    });
    const semantics = validateWorldQueryPlanSemantics(submission.plan);
    if (!semantics.valid) this.fail("World query plan semantic validation failed", { issues: semantics.issues });
    this.assertPrincipal(principal);
    this.assertNoSecurityClaims(submission.parameters, "parameters");
    this.assertNoSecurityClaims(submission.plan, "plan");
    this.assertSystemBudgets(submission);

    const nodes = new Map(submission.plan.nodes.map((node) => [node.nodeId, node]));
    const routes = new Map<string, ResolvedCapability>();
    const dependencies = new Map<string, Set<string>>();

    for (const node of submission.plan.nodes) {
      const route = this.registry.resolve(
        node.operation.operationId,
        node.operation.operationVersion,
        principal.allowExperimental ?? false
      );
      this.assertOperationLock(node, route.descriptor);
      this.assertScope(route.descriptor, principal);
      this.assertSnapshotSupport(route.descriptor);
      this.assertNodeBudget(node, route.descriptor);
      this.assertInputPorts(node, route.descriptor, nodes, routes, submission.plan.nodes, principal);
      for (const precondition of node.preconditions ?? []) {
        if (precondition.kind !== "NODE_STATUS" && precondition.binding.targetPath !== undefined) {
          this.fail("targetPath is only valid for composite node inputs", {
            nodeId: node.nodeId,
            location: "precondition"
          });
        }
        if (precondition.kind !== "NODE_STATUS") {
          this.assertCanonicalSchema(
            precondition.binding.port.schemaUri,
            precondition.binding.port.schemaHash,
            node.nodeId
          );
          if (precondition.binding.kind === "NODE_OUTPUT") {
            this.assertControlledOutputBinding(
              precondition.binding,
              nodes,
              routes,
              principal,
              { nodeId: node.nodeId, location: "precondition" }
            );
          }
        }
      }
      routes.set(node.nodeId, route);
      dependencies.set(node.nodeId, dependenciesForNode(node));
    }

    for (const output of submission.plan.outputs) {
      if (output.binding.targetPath !== undefined) {
        this.fail("targetPath is only valid for composite node inputs", {
          nodeId: output.binding.nodeId,
          output: output.name
        });
      }
      this.assertControlledOutputBinding(
        output.binding,
        nodes,
        routes,
        principal,
        { nodeId: output.binding.nodeId, output: output.name }
      );
      this.assertCanonicalSchema(output.binding.port.schemaUri, output.binding.port.schemaHash, output.binding.nodeId);
    }

    const orderedNodes = topologicalOrder(submission.plan.nodes, dependencies, (message, details) =>
      this.fail(message, details)
    );
    return { submission, orderedNodes, routes, dependencies };
  }

  private assertSystemBudgets(submission: WorldQuerySubmission): void {
    const requested = submission.plan.budgets;
    for (const name of [
      "maximumNodes",
      "maximumDepth",
      "maximumRows",
      "maximumCandidates",
      "maximumOutputBytes",
      "maximumExecutionMs"
    ] as const) {
      if (requested[name] > this.policy[name]) this.fail(`Plan ${name} exceeds Gateway policy`, {
        requested: requested[name],
        allowed: this.policy[name]
      });
    }
  }

  private assertOperationLock(node: WorldQueryPlanV2Node, descriptor: CapabilityDescriptor): void {
    if (
      node.operation.inputSchemaHash !== descriptor.inputSchemaHash ||
      node.operation.outputSchemaHash !== descriptor.outputSchemaHash
    ) {
      this.fail("Query node schema lock differs from the controlled Registry", {
        nodeId: node.nodeId,
        operationId: descriptor.operationId,
        operationVersion: descriptor.operationVersion
      });
    }
    this.assertCanonicalSchema(descriptor.inputSchemaUri, descriptor.inputSchemaHash, node.nodeId);
    this.assertCanonicalSchema(descriptor.outputSchemaUri, descriptor.outputSchemaHash, node.nodeId);
  }

  private assertCanonicalSchema(schemaUri: string, schemaHash: string, nodeId: string): void {
    try {
      const canonicalHash = getContractSchemaHash(schemaUri);
      if (canonicalHash !== schemaHash) this.fail("Registry schema hash differs from the canonical contract", {
        nodeId,
        schemaUri,
        registeredHash: schemaHash,
        canonicalHash
      });
    } catch (error) {
      if (error instanceof ProviderProtocolError) throw error;
      this.fail("Registry references a schema outside the committed contract bundle", {
        nodeId,
        schemaUri,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private assertInputPorts(
    node: WorldQueryPlanV2Node,
    descriptor: CapabilityDescriptor,
    nodes: ReadonlyMap<string, WorldQueryPlanV2Node>,
    routes: ReadonlyMap<string, ResolvedCapability>,
    orderedSource: readonly WorldQueryPlanV2Node[],
    principal: GatewayPrincipal
  ): void {
    const inputEntries = Object.entries(node.inputs);
    const actualNames = inputEntries.map(([name]) => name);
    const wholeRequestBinding =
      actualNames.length === 1 &&
      actualNames[0] === "request" &&
      descriptor.ports.inputs.length === 1 &&
      descriptor.ports.inputs[0]?.name === "request";
    this.assertTargetPaths(node.nodeId, inputEntries, wholeRequestBinding);
    for (const [name, binding] of inputEntries) {
      const targetPort = wholeRequestBinding ? descriptor.ports.inputs[0] : undefined;
      if (targetPort) this.assertPortEqual(binding.port, targetPort, { nodeId: node.nodeId, inputPort: name });
      this.assertCanonicalSchema(binding.port.schemaUri, binding.port.schemaHash, node.nodeId);
      if (binding.kind === "NODE_OUTPUT") {
        const sourcePort = this.assertControlledOutputBinding(
          binding,
          nodes,
          routes,
          principal,
          { nodeId: node.nodeId, sourceNodeId: binding.nodeId, outputPort: binding.outputPort }
        );
        if (sourcePort.valueKind === "H3_CELL_SET" && binding.port.valueKind === "GEOMETRY") {
          this.fail("An H3 candidate set cannot feed an exact Geometry boolean port", {
            nodeId: node.nodeId,
            sourceNodeId: binding.nodeId
          });
        }
      }
      if (
        descriptor.operationId === "geometry.buffer" &&
        name.toLowerCase().includes("distance") &&
        binding.port.unitSemantics === "ANGULAR_DEGREES" &&
        !wholeRequestBinding
      ) {
        this.fail("Angular coordinates cannot be interpreted as a metre buffer distance", {
          nodeId: node.nodeId,
          inputPort: name
        });
      }
    }
    if (!wholeRequestBinding && descriptor.ports.inputs.length !== 1) {
      this.fail("Composite query inputs require an operation with one canonical request envelope", {
        nodeId: node.nodeId,
        inputPorts: descriptor.ports.inputs.map((port) => port.name)
      });
    }
    void orderedSource;
  }

  private assertControlledOutputBinding(
    binding: NodeOutputBinding,
    nodes: ReadonlyMap<string, WorldQueryPlanV2Node>,
    routes: ReadonlyMap<string, ResolvedCapability>,
    principal: GatewayPrincipal,
    details: Readonly<Record<string, unknown>>
  ): CapabilityDescriptor["ports"]["outputs"][number] {
    const sourceNode = nodes.get(binding.nodeId);
    if (!sourceNode) this.fail("Node binding references an unknown node", {
      ...details,
      sourceNodeId: binding.nodeId
    });
    const sourceRoute = routes.get(binding.nodeId) ?? this.registry.resolve(
      sourceNode.operation.operationId,
      sourceNode.operation.operationVersion,
      principal.allowExperimental ?? false
    );
    const sourcePort = sourceRoute.descriptor.ports.outputs.find((port) => port.name === binding.outputPort);
    if (!sourcePort) this.fail("Node binding references an unknown output port", {
      ...details,
      sourceNodeId: binding.nodeId,
      outputPort: binding.outputPort
    });
    if (binding.path !== sourcePort.path) {
      this.fail("Node output path differs from the controlled Registry port selector", {
        ...details,
        sourceNodeId: binding.nodeId,
        outputPort: binding.outputPort,
        requestedPath: binding.path,
        controlledPath: sourcePort.path
      });
    }
    this.assertPortEqual(binding.port, sourcePort, {
      ...details,
      sourceNodeId: binding.nodeId,
      outputPort: binding.outputPort
    });
    return sourcePort;
  }

  private assertTargetPaths(
    nodeId: string,
    entries: Array<[string, WorldQueryPlanV2InputBinding]>,
    wholeRequestBinding: boolean
  ): void {
    if (wholeRequestBinding) {
      const binding = entries[0]?.[1];
      if (binding?.targetPath !== undefined) {
        this.fail("targetPath is forbidden on a whole request binding", { nodeId, targetPath: binding.targetPath });
      }
      return;
    }
    const targets = entries.map(([name, binding]) => {
      const path = binding.targetPath ?? `/${name}`;
      const segments = targetPathSegments(path);
      if (segments.length > MAX_TARGET_PATH_DEPTH) {
        this.fail("targetPath exceeds the bounded object depth", {
          nodeId,
          inputPort: name,
          targetPath: path,
          maximumDepth: MAX_TARGET_PATH_DEPTH
        });
      }
      const unsafe = segments.find((segment) => {
        const normalized = segment.toLowerCase();
        return UNSAFE_TARGET_SEGMENTS.has(normalized) || RESERVED_SECURITY_KEYS.has(normalized);
      });
      if (unsafe !== undefined) {
        this.fail("targetPath contains a forbidden object segment", {
          nodeId,
          inputPort: name,
          targetPath: path,
          segment: unsafe
        });
      }
      return { name, path, segments };
    });
    for (let left = 0; left < targets.length; left += 1) {
      for (let right = left + 1; right < targets.length; right += 1) {
        const a = targets[left]!;
        const b = targets[right]!;
        if (targetPrefix(a.segments, b.segments) || targetPrefix(b.segments, a.segments)) {
          this.fail("targetPath values conflict", {
            nodeId,
            firstInput: a.name,
            firstTargetPath: a.path,
            secondInput: b.name,
            secondTargetPath: b.path
          });
        }
      }
    }
  }

  private assertPortEqual(
    actual: WorldQueryPlanV2SchemaPort,
    expected: Omit<WorldQueryPlanV2SchemaPort, never>,
    details: Readonly<Record<string, unknown>>
  ): void {
    if (
      actual.schemaUri !== expected.schemaUri ||
      actual.schemaHash !== expected.schemaHash ||
      actual.valueKind !== expected.valueKind ||
      actual.unitSemantics !== expected.unitSemantics
    ) {
      this.fail("Typed DAG port is incompatible with the controlled operation port", {
        ...details,
        expected,
        actual
      });
    }
  }

  private assertNodeBudget(node: WorldQueryPlanV2Node, descriptor: CapabilityDescriptor): void {
    const comparisons = [
      ["maximumRows", node.budget.maximumRows, descriptor.limits.maximumRows],
      ["maximumCandidates", node.budget.maximumCandidates, descriptor.limits.maximumCandidates],
      ["maximumOutputBytes", node.budget.maximumOutputBytes, descriptor.limits.maximumOutputBytes],
      ["maximumExecutionMs", node.budget.maximumExecutionMs, descriptor.execution.maximumTimeoutMs]
    ] as const;
    for (const [name, requested, allowed] of comparisons) {
      if (allowed !== undefined && requested > allowed) this.fail(`Node ${name} exceeds Provider policy`, {
        nodeId: node.nodeId,
        requested,
        allowed
      });
    }
  }

  private assertScope(descriptor: CapabilityDescriptor, principal: GatewayPrincipal): void {
    if (descriptor.scopePolicy === "DATA_SCOPE_REQUIRED" && !principal.dataScopeClaim?.trim()) {
      this.fail("Query operation requires a trusted DataScope claim", { operationId: descriptor.operationId });
    }
    if (descriptor.scopePolicy === "DATASET_SCOPE_REQUIRED" && !principal.datasetScopeClaim?.trim()) {
      this.fail("Query operation requires a trusted DatasetScope claim", { operationId: descriptor.operationId });
    }
  }

  private assertSnapshotSupport(descriptor: CapabilityDescriptor): void {
    const dataBound = ["WORLD_SNAPSHOT_BOUND", "DATASET_VERSION_BOUND"].includes(descriptor.dataBinding);
    if (dataBound && descriptor.snapshotPolicy.dataSnapshot === "NONE") {
      this.fail("Data-bound operation cannot satisfy the required Data Snapshot", {
        operationId: descriptor.operationId,
        operationVersion: descriptor.operationVersion
      });
    }
  }

  private assertPrincipal(principal: GatewayPrincipal): void {
    if (!principal.principalRef.trim() || !principal.authenticationMethod.trim() || !Number.isFinite(Date.parse(principal.authenticatedAt))) {
      this.fail("Authenticated transport principal is required", {});
    }
  }

  private assertNoSecurityClaims(value: unknown, rootPath: string): void {
    const visit = (entry: unknown, path: string): void => {
      if (Array.isArray(entry)) {
        entry.forEach((item, index) => visit(item, `${path}/${index}`));
        return;
      }
      if (entry === null || typeof entry !== "object") return;
      for (const [key, child] of Object.entries(entry)) {
        if (RESERVED_SECURITY_KEYS.has(key.toLowerCase())) this.fail("World query submission contains a reserved security field", {
          path: `${path}/${key}`
        });
        visit(child, `${path}/${key}`);
      }
    };
    visit(value, rootPath);
  }

  private fail(message: string, details: Readonly<Record<string, unknown>>): never {
    throw new ProviderProtocolError("INVALID_REQUEST", message, {
      details: { stage: "DAG_VALIDATION", ...details }
    });
  }
}

function targetPathSegments(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new ProviderProtocolError("INVALID_REQUEST", "targetPath must be a rooted JSON Pointer", {
      details: { stage: "DAG_VALIDATION", targetPath: path }
    });
  }
  return path.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function targetPrefix(left: readonly string[], right: readonly string[]): boolean {
  return left.length <= right.length && left.every((segment, index) => right[index] === segment);
}

function dependenciesForNode(node: WorldQueryPlanV2Node): Set<string> {
  const dependencies = new Set<string>();
  const addBinding = (binding: WorldQueryPlanV2InputBinding): void => {
    if (binding.kind === "NODE_OUTPUT") dependencies.add(binding.nodeId);
  };
  Object.values(node.inputs).forEach(addBinding);
  for (const precondition of node.preconditions ?? []) {
    if (precondition.kind === "NODE_STATUS") dependencies.add(precondition.nodeId);
    else addBinding(precondition.binding);
  }
  return dependencies;
}

function topologicalOrder(
  nodes: readonly WorldQueryPlanV2Node[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  fail: (message: string, details: Readonly<Record<string, unknown>>) => never
): WorldQueryPlanV2Node[] {
  const remaining = new Map([...dependencies].map(([nodeId, values]) => [nodeId, new Set(values)]));
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const ordered: WorldQueryPlanV2Node[] = [];
  while (remaining.size > 0) {
    const ready = nodes
      .map((node) => node.nodeId)
      .filter((nodeId) => remaining.get(nodeId)?.size === 0)
      .sort();
    if (ready.length === 0) fail("World query plan contains a cycle", { nodes: [...remaining.keys()].sort() });
    for (const nodeId of ready) {
      const node = byId.get(nodeId);
      if (!node) fail("World query plan lost a node during ordering", { nodeId });
      ordered.push(node);
      remaining.delete(nodeId);
      for (const values of remaining.values()) values.delete(nodeId);
    }
  }
  return ordered;
}
