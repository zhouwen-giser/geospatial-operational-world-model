import { describe, expect, it } from "vitest";
import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  WorldQueryPlanV2,
  WorldQueryPlanV2InputBinding,
  WorldQueryPlanV2Node,
  WorldQueryPlanV2SchemaPort,
  WorldQuerySubmission
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  getContractSchema,
  getContractSchemaHash,
  validateCapabilityDescriptorSemantics
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  ProviderProtocolError,
  sha256,
  type ProviderOperation
} from "../../packages/platform/provider-sdk/src/index.js";
import {
  buildGatewayApp,
  CapabilityRegistry,
  DirectExecutionService,
  InProcessProviderClient,
  MemoryAuditSink,
  MemoryGatewayIdempotencyStore,
  MemoryGatewayRecordStore,
  MemoryQueryPlanStore,
  ProviderCircuitBreaker,
  QueryPlanValidator,
  WorldQueryRuntime,
  type GatewayPrincipal
} from "../../services/gateway/world-capability-gateway/src/index.js";

const positionSchemaUri = "urn:gowm:capability:elevation.sample.mock:input:1.0";
const elevationSchemaUri = "urn:gowm:capability:elevation.sample.mock:output:1.0";
const positionSchema = getContractSchema(positionSchemaUri);
const elevationSchema = getContractSchema(elevationSchemaUri);
const parameterSchemaHash = getContractSchemaHash("world-query-parameters.schema.json");
const numberSchemaUri = "urn:gowm:v0.2:value:number";
const numberSchemaHash = getContractSchemaHash(numberSchemaUri);
const nestedSchemaUri = "urn:gowm:capability:geometry.make-valid:input:1.0";
const nestedSchema = getContractSchema(nestedSchemaUri);
const geometryLeafSchemaUri = "urn:gowm:capability:geometry:geojson-geometry:1.0";
const coordinateSpaceSchemaUri = "urn:gowm:capability:geometry:coordinate-space:1.0";
const coordinateLayoutSchemaUri = "urn:gowm:capability:geometry:coordinate-layout:1.0";

const principal: GatewayPrincipal = {
  principalRef: "principal:dag-test",
  authenticationMethod: "TEST_ATTESTED",
  authenticatedAt: new Date(Date.now() - 1_000).toISOString(),
  allowExperimental: true
};

interface Harness {
  descriptors: Record<"source" | "sample" | "fail" | "nested", CapabilityDescriptor>;
  runtime: WorldQueryRuntime;
  store: MemoryQueryPlanStore;
  registry: CapabilityRegistry;
  direct: DirectExecutionService;
  records: MemoryGatewayRecordStore;
  calls: Record<"source" | "sample" | "fail", number>;
  nestedCalls: () => number;
}

function descriptor(
  operationId: string,
  input: {
    uri: string;
    hash: `sha256:${string}`;
    kind: CapabilityDescriptor["ports"]["inputs"][number]["valueKind"];
    unit?: CapabilityDescriptor["ports"]["inputs"][number]["unitSemantics"];
  },
  output: {
    uri: string;
    hash: `sha256:${string}`;
    kind: CapabilityDescriptor["ports"]["outputs"][number]["valueKind"];
    unit?: CapabilityDescriptor["ports"]["outputs"][number]["unitSemantics"];
  }
): CapabilityDescriptor {
  return {
    operationId,
    operationVersion: "1.0",
    semanticRole: "GENERIC_ANALYSIS",
    dataBinding: "WORLD_INDEPENDENT",
    resultSemantics: "DERIVED_ANALYSIS",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: "PREVIEW",
    inputSchemaUri: input.uri,
    inputSchemaHash: input.hash,
    outputSchemaUri: output.uri,
    outputSchemaHash: output.hash,
    scopePolicy: "REQUEST_CONTEXT",
    execution: { mode: "SYNC", defaultTimeoutMs: 1_000, maximumTimeoutMs: 5_000, costClass: "LOW" },
    limits: {
      maximumInputBytes: 65_536,
      maximumOutputBytes: 65_536,
      maximumRows: 100,
      maximumCandidates: 100,
      maximumBatchItems: 100
    },
    snapshotPolicy: { dataSnapshot: "NONE", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: input.uri,
        schemaHash: input.hash,
        valueKind: input.kind,
        unitSemantics: input.unit ?? (input.kind === "POSITION" ? "ANGULAR_DEGREES" : "UNSPECIFIED")
      }],
      outputs: [{
        name: "result",
        schemaUri: output.uri,
        schemaHash: output.hash,
        valueKind: output.kind,
        unitSemantics: output.unit ?? (
          output.kind === "SCALAR" ? "LINEAR_METERS" : output.kind === "POSITION" ? "ANGULAR_DEGREES" : "UNSPECIFIED"
        )
      }]
    }
  };
}

function harness(autoRunAsync = false, configure?: (descriptors: Harness["descriptors"]) => void): Harness {
  const positionHash = getContractSchemaHash(positionSchemaUri);
  const elevationHash = getContractSchemaHash(elevationSchemaUri);
  const nestedHash = getContractSchemaHash(nestedSchemaUri);
  const source = descriptor("test.position.source", { uri: positionSchemaUri, hash: positionHash, kind: "POSITION" }, {
    uri: positionSchemaUri, hash: positionHash, kind: "POSITION"
  });
  source.ports.outputs.push({
    name: "longitude",
    path: "/longitude",
    schemaUri: numberSchemaUri,
    schemaHash: numberSchemaHash,
    valueKind: "SCALAR",
    unitSemantics: "ANGULAR_DEGREES"
  });
  const descriptors = {
    source,
    sample: descriptor("test.elevation.sample", { uri: positionSchemaUri, hash: positionHash, kind: "POSITION" }, {
      uri: elevationSchemaUri, hash: elevationHash, kind: "SCALAR"
    }),
    fail: descriptor("test.position.fail", { uri: positionSchemaUri, hash: positionHash, kind: "POSITION" }, {
      uri: positionSchemaUri, hash: positionHash, kind: "POSITION"
    }),
    nested: descriptor("test.geometry.operand", {
      uri: nestedSchemaUri, hash: nestedHash, kind: "ANY", unit: "UNSPECIFIED"
    }, {
      uri: nestedSchemaUri, hash: nestedHash, kind: "ANY", unit: "UNSPECIFIED"
    })
  };
  configure?.(descriptors);
  const calls: Record<"source" | "sample" | "fail", number> = { source: 0, sample: 0, fail: 0 };
  let nestedCalls = 0;
  const operations: ProviderOperation[] = [
    {
      descriptor: descriptors.source,
      inputSchema: positionSchema,
      outputSchema: positionSchema,
      method: { engine: "dag-fixture", engineVersion: "1.0.0", methodId: "identity", methodVersion: "1.0" },
      async handle(input) {
        calls.source += 1;
        return { status: "COMPLETED", value: input, consumption: { rows: 1, candidates: 1 } };
      }
    },
    {
      descriptor: descriptors.sample,
      inputSchema: positionSchema,
      outputSchema: elevationSchema,
      method: { engine: "dag-fixture", engineVersion: "1.0.0", methodId: "sample", methodVersion: "1.0" },
      async handle() {
        calls.sample += 1;
        return {
          status: "COMPLETED",
          value: { elevationMeters: 88.5, source: "MOCK_FIXED" },
          consumption: { rows: 1, candidates: 1 }
        };
      }
    },
    {
      descriptor: descriptors.fail,
      inputSchema: positionSchema,
      outputSchema: positionSchema,
      method: { engine: "dag-fixture", engineVersion: "1.0.0", methodId: "fail", methodVersion: "1.0" },
      async handle() {
        calls.fail += 1;
        throw new ProviderProtocolError("OVERLOADED", "fixture overload", { retryable: true });
      }
    },
    {
      descriptor: descriptors.nested,
      inputSchema: nestedSchema,
      outputSchema: nestedSchema,
      method: { engine: "dag-fixture", engineVersion: "1.0.0", methodId: "nested-identity", methodVersion: "1.0" },
      async handle(input) {
        nestedCalls += 1;
        return { status: "COMPLETED", value: input, consumption: { rows: 1, candidates: 1 } };
      }
    }
  ];
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0",
    provider: {
      providerId: "gowm.dag-fixture",
      providerVersion: "0.2.0",
      owner: "gowm-platform",
      implementationDigest: sha256({ fixture: "dag", version: "1.0" }),
      sourceRef: "urn:gowm:source:test:dag-fixture"
    },
    endpoints: {
      manifest: "/v1/manifest",
      liveness: "/health/live",
      readiness: "/health/ready",
      execute: "/v1/operations/{operationId}:execute",
      job: "/v1/jobs/{jobId}"
    },
    capabilities: Object.values(descriptors)
  };
  const provider = createProviderRuntime({
    manifest,
    operations,
    policyVersion: "dag-fixture/1.0",
    policyDigest: sha256({ policy: "dag-fixture/1.0" })
  });
  const registry = new CapabilityRegistry();
  registry.register({
    approvalId: "approval-dag-fixture",
    approved: true,
    endpoint: new URL("http://127.0.0.1:34100/"),
    client: new InProcessProviderClient(provider),
    manifest
  });
  const records = new MemoryGatewayRecordStore();
  const direct = new DirectExecutionService({
    registry,
    circuits: new ProviderCircuitBreaker(),
    idempotency: new MemoryGatewayIdempotencyStore(),
    audit: new MemoryAuditSink(),
    gatewayId: "gateway-dag-test",
    policyVersion: "gateway-dag-test/1.0",
    attestationIssuer: "gateway-dag-test",
    records
  });
  const store = new MemoryQueryPlanStore();
  const runtime = new WorldQueryRuntime({
    validator: new QueryPlanValidator(registry),
    directExecution: direct,
    store,
    autoRunAsync
  });
  return { descriptors, runtime, store, registry, direct, records, calls, nestedCalls: () => nestedCalls };
}

function operation(descriptor: CapabilityDescriptor) {
  return {
    operationId: descriptor.operationId,
    operationVersion: descriptor.operationVersion,
    inputSchemaHash: descriptor.inputSchemaHash,
    outputSchemaHash: descriptor.outputSchemaHash
  };
}

function schemaPort(port: CapabilityDescriptor["ports"]["inputs"][number]) {
  return {
    schemaUri: port.schemaUri,
    schemaHash: port.schemaHash,
    valueKind: port.valueKind,
    unitSemantics: port.unitSemantics
  };
}

function numberPort(unitSemantics: "ANGULAR_DEGREES" | "LINEAR_METERS" | "DIMENSIONLESS" = "DIMENSIONLESS") {
  return {
    schemaUri: numberSchemaUri,
    schemaHash: numberSchemaHash,
    valueKind: "SCALAR" as const,
    unitSemantics
  };
}

function canonicalPort(
  schemaUri: string,
  valueKind: WorldQueryPlanV2SchemaPort["valueKind"],
  unitSemantics: WorldQueryPlanV2SchemaPort["unitSemantics"]
): WorldQueryPlanV2SchemaPort {
  return { schemaUri, schemaHash: getContractSchemaHash(schemaUri), valueKind, unitSemantics };
}

function targetedLiteral(
  value: unknown,
  port: WorldQueryPlanV2SchemaPort,
  targetPath?: string
): WorldQueryPlanV2InputBinding {
  return { kind: "LITERAL", value, port, ...(targetPath === undefined ? {} : { targetPath }) };
}

function nestedOperandInputs(): Record<string, WorldQueryPlanV2InputBinding> {
  return {
    geometryLeaf: targetedLiteral(
      { type: "Point", coordinates: [116.4, 39.9] },
      canonicalPort(geometryLeafSchemaUri, "GEOMETRY", "ANGULAR_DEGREES"),
      "/input/geometry"
    ),
    coordinateSpaceLeaf: targetedLiteral(
      "EPSG:4326",
      canonicalPort(coordinateSpaceSchemaUri, "SCALAR", "UNSPECIFIED"),
      "/input/coordinateSpace"
    ),
    coordinateLayoutLeaf: targetedLiteral(
      "XY",
      canonicalPort(coordinateLayoutSchemaUri, "SCALAR", "UNSPECIFIED"),
      "/input/coordinateLayout"
    )
  };
}

function node(
  nodeId: string,
  descriptor: CapabilityDescriptor,
  input: WorldQueryPlanV2Node["inputs"],
  failurePolicy: WorldQueryPlanV2Node["failurePolicy"] = "FAIL_FAST"
): WorldQueryPlanV2Node {
  return {
    nodeId,
    operation: operation(descriptor),
    inputs: input,
    failurePolicy,
    budget: {
      maximumRows: 10,
      maximumCandidates: 10,
      maximumOutputBytes: 16_384,
      maximumExecutionMs: 1_000
    }
  };
}

function literalInput(descriptor: CapabilityDescriptor) {
  const port = descriptor.ports.inputs[0];
  if (!port) throw new Error("fixture input port missing");
  return {
    request: {
      kind: "LITERAL" as const,
      port: schemaPort(port),
      value: { longitude: 116.4, latitude: 39.9 }
    }
  };
}

function linkedInput(source: CapabilityDescriptor, target: CapabilityDescriptor, sourceNodeId: string) {
  const sourcePort = source.ports.outputs[0];
  const targetPort = target.ports.inputs[0];
  if (!sourcePort || !targetPort) throw new Error("fixture port missing");
  expect(schemaPort(sourcePort)).toEqual(schemaPort(targetPort));
  return {
    request: {
      kind: "NODE_OUTPUT" as const,
      port: schemaPort(targetPort),
      nodeId: sourceNodeId,
      outputPort: sourcePort.name
    }
  };
}

function submission(
  queryId: string,
  nodes: WorldQueryPlanV2Node[],
  outputNodeId: string,
  outputDescriptor: CapabilityDescriptor,
  overrides: Partial<WorldQueryPlanV2["budgets"]> = {}
): WorldQuerySubmission {
  const outputPort = outputDescriptor.ports.outputs[0];
  if (!outputPort) throw new Error("fixture output port missing");
  return {
    requestId: `request:${queryId}`,
    idempotencyKey: `idem:${queryId}`,
    parameterSchemaHash,
    parameters: {},
    plan: {
      queryPlanVersion: "2.0",
      queryId,
      nodes,
      outputs: [{
        name: "answer",
        binding: {
          kind: "NODE_OUTPUT",
          nodeId: outputNodeId,
          outputPort: outputPort.name,
          port: schemaPort(outputPort)
        }
      }],
      budgets: {
        maximumNodes: nodes.length,
        maximumDepth: nodes.length,
        maximumRows: nodes.length * 10,
        maximumCandidates: nodes.length * 10,
        maximumOutputBytes: nodes.length * 16_384,
        maximumExecutionMs: nodes.length * 1_000,
        ...overrides
      }
    }
  };
}

describe("World Query DAG runtime", () => {
  it("rejects unsafe or incomplete Registry output selector declarations", () => {
    const test = harness();
    const unsafe = structuredClone(test.descriptors.source);
    unsafe.ports.outputs.push({
      ...numberPort("ANGULAR_DEGREES"),
      name: "forgedSecurityContext",
      path: "/SeCuRiTyCoNtExT/claim"
    });
    const missingPath = structuredClone(test.descriptors.source);
    missingPath.ports.outputs.push({ ...numberPort("ANGULAR_DEGREES"), name: "undeclaredSelector" });

    expect(validateCapabilityDescriptorSemantics(unsafe)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ keyword: "unsafeOutputSelector" })])
    });
    expect(validateCapabilityDescriptorSemantics(missingPath)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ keyword: "outputSelector" })])
    });
  });

  it("executes typed nodes, persists hashes and replays the query idempotently", async () => {
    const test = harness();
    const source = node("source", test.descriptors.source, literalInput(test.descriptors.source));
    const sample = node("sample", test.descriptors.sample, linkedInput(test.descriptors.source, test.descriptors.sample, "source"));
    const request = submission("query_typed", [source, sample], "sample", test.descriptors.sample);

    const first = await test.runtime.submit(request, principal);
    const replay = await test.runtime.submit(structuredClone(request), principal);
    const persisted = await test.store.listNodes(first.job.jobId);

    expect(first.result).toMatchObject({ status: "COMPLETED", outputs: { answer: { elevationMeters: 88.5 } } });
    expect(first.result?.nodes.every((entry) => entry.inputHash && entry.outputHash)).toBe(true);
    expect(persisted.every((entry) => entry.inputHash && entry.outputHash)).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect(test.calls).toMatchObject({ source: 1, sample: 1 });
  });

  it("rejects cycles and aggregate budget overflow before any provider call", async () => {
    const test = harness();
    const cycleA = node("cycleA", test.descriptors.source, linkedInput(test.descriptors.source, test.descriptors.source, "cycleB"));
    const cycleB = node("cycleB", test.descriptors.source, linkedInput(test.descriptors.source, test.descriptors.source, "cycleA"));
    const cyclic = submission("query_cycle", [cycleA, cycleB], "cycleB", test.descriptors.source);
    const source = node("source", test.descriptors.source, literalInput(test.descriptors.source));
    const sample = node("sample", test.descriptors.sample, linkedInput(test.descriptors.source, test.descriptors.sample, "source"));
    const overBudget = submission("query_budget", [source, sample], "sample", test.descriptors.sample, { maximumRows: 10 });

    await expect(test.runtime.submit(cyclic, principal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(test.runtime.submit(overBudget, principal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(test.calls).toEqual({ source: 0, sample: 0, fail: 0 });
  });

  it("rejects an incompatible typed port before execution", async () => {
    const test = harness();
    const source = node("source", test.descriptors.source, literalInput(test.descriptors.source));
    const wrongPort = test.descriptors.sample.ports.outputs[0];
    if (!wrongPort) throw new Error("fixture wrong port missing");
    const sample = node("sample", test.descriptors.sample, {
      request: { kind: "NODE_OUTPUT", nodeId: "source", outputPort: "result", port: schemaPort(wrongPort) }
    });
    const request = submission("query_port_mismatch", [source, sample], "sample", test.descriptors.sample);

    await expect(test.runtime.submit(request, principal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(test.calls).toEqual({ source: 0, sample: 0, fail: 0 });
  });

  it.each(["REFERENCE_KEY", "GEOMETRY"] as const)("rejects incompatible explicit %s semantics before any Provider execution", async (kind) => {
    const test = harness(false, (descriptors) => {
      const p: NonNullable<CapabilityDescriptor["semanticProfile"]> = {
        profileVersion: "1.0", domain: "SPATIAL", acceptedReferenceKinds: [], producedReferenceKinds: [], relationSemantics: [],
        spatialSemantics: "NONE", timeSemantics: "NONE", resultNature: "DERIVED", negativeEvidencePolicy: "NOT_APPLICABLE", freshnessSemantics: "NONE"
      };
      descriptors.source.semanticProfile = { ...p, producedReferenceKinds: ["WORLD_OBJECT"], spatialSemantics: kind === "GEOMETRY" ? "CANDIDATE" : "NONE" };
      descriptors.sample.semanticProfile = { ...p, acceptedReferenceKinds: ["DATASET"], spatialSemantics: kind === "GEOMETRY" ? "EXACT" : "NONE" };
      descriptors.source.ports.outputs[0]!.valueKind = kind;
      descriptors.sample.ports.inputs[0]!.valueKind = kind;
    });
    const source = node("source", test.descriptors.source, literalInput(test.descriptors.source));
    const sample = node("sample", test.descriptors.sample, linkedInput(test.descriptors.source, test.descriptors.sample, "source"));
    const request = submission(`query_semantic_${kind}`, [source, sample], "sample", test.descriptors.sample);
    await expect(test.runtime.submit(request, principal)).rejects.toThrow(kind === "REFERENCE_KEY" ? "ReferenceKind" : "Candidate geometry");
    expect(test.calls).toEqual({ source: 0, sample: 0, fail: 0 });
  });

  it("builds a canonical request envelope from typed field and output-path bindings", async () => {
    const test = harness();
    const source = node("source", test.descriptors.source, literalInput(test.descriptors.source));
    const sample = node("sample", test.descriptors.sample, {
      longitude: {
        kind: "NODE_OUTPUT",
        nodeId: "source",
        outputPort: "longitude",
        path: "/longitude",
        port: numberPort("ANGULAR_DEGREES")
      },
      latitude: {
        kind: "LITERAL",
        value: 39.9,
        port: numberPort("ANGULAR_DEGREES")
      }
    });
    const request = submission("query_composite", [source, sample], "sample", test.descriptors.sample);

    const executed = await test.runtime.submit(request, principal);

    expect(executed.result).toMatchObject({
      status: "COMPLETED",
      outputs: { answer: { elevationMeters: 88.5 } }
    });
    expect(test.calls).toMatchObject({ source: 1, sample: 1 });
  });

  it("rejects caller-selected output paths or forged path port semantics", async () => {
    const test = harness();
    const sourceFor = () => node("source", test.descriptors.source, literalInput(test.descriptors.source));
    const composite = (
      queryId: string,
      path: string,
      port: WorldQueryPlanV2SchemaPort = numberPort("ANGULAR_DEGREES")
    ) => {
      const source = sourceFor();
      const sample = node("sample", test.descriptors.sample, {
        longitude: {
          kind: "NODE_OUTPUT",
          nodeId: "source",
          outputPort: "longitude",
          path,
          port
        },
        latitude: { kind: "LITERAL", value: 39.9, port: numberPort("ANGULAR_DEGREES") }
      });
      return submission(queryId, [source, sample], "sample", test.descriptors.sample);
    };

    const inputPathMismatch = composite("query_controlled_input_path", "/latitude");
    const forgedUnit = composite("query_controlled_input_unit", "/longitude", numberPort("LINEAR_METERS"));
    const preconditionPathMismatch = submission(
      "query_controlled_precondition_path",
      [
        sourceFor(),
        node(
          "sample",
          test.descriptors.sample,
          linkedInput(test.descriptors.source, test.descriptors.sample, "source"),
          "SKIP_IF_PRECONDITION_FALSE"
        )
      ],
      "sample",
      test.descriptors.sample
    );
    preconditionPathMismatch.plan.nodes[1]!.preconditions = [{
      kind: "VALUE_EQUALS",
      value: 116.4,
      binding: {
        kind: "NODE_OUTPUT",
        nodeId: "source",
        outputPort: "longitude",
        path: "/latitude",
        port: numberPort("ANGULAR_DEGREES")
      }
    }];
    const outputPathMismatch = submission(
      "query_controlled_result_path",
      [sourceFor()],
      "source",
      test.descriptors.source
    );
    outputPathMismatch.plan.outputs[0]!.binding = {
      kind: "NODE_OUTPUT",
      nodeId: "source",
      outputPort: "longitude",
      path: "/latitude",
      port: numberPort("ANGULAR_DEGREES")
    };

    for (const request of [inputPathMismatch, forgedUnit, preconditionPathMismatch, outputPathMismatch]) {
      await expect(test.runtime.submit(request, principal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(test.calls).toEqual({ source: 0, sample: 0, fail: 0 });
  });

  it("builds a schema-validated nested request from typed targetPath leaf bindings", async () => {
    const test = harness();
    const nested = node("nested", test.descriptors.nested, nestedOperandInputs());
    const request = submission("query_nested_target", [nested], "nested", test.descriptors.nested);

    const executed = await test.runtime.submit(request, principal);

    expect(executed.result).toMatchObject({
      status: "COMPLETED",
      outputs: {
        answer: {
          input: {
            geometry: { type: "Point", coordinates: [116.4, 39.9] },
            coordinateSpace: "EPSG:4326",
            coordinateLayout: "XY"
          }
        }
      }
    });
    expect(test.nestedCalls()).toBe(1);
  });

  it("validates both typed leaves and the fully assembled nested operation request", async () => {
    const test = harness();
    const geometryLeafPort = canonicalPort(geometryLeafSchemaUri, "GEOMETRY", "ANGULAR_DEGREES");
    const incomplete = node("nested", test.descriptors.nested, {
      geometry: targetedLiteral(
        { type: "Point", coordinates: [116.4, 39.9] },
        geometryLeafPort,
        "/input/geometry"
      )
    });
    const invalidLeafInputs = nestedOperandInputs();
    invalidLeafInputs.coordinateSpaceLeaf = targetedLiteral(
      "CALLER_DEFINED_CRS",
      canonicalPort(coordinateSpaceSchemaUri, "SCALAR", "UNSPECIFIED"),
      "/input/coordinateSpace"
    );
    const invalidLeaf = node("nested", test.descriptors.nested, invalidLeafInputs);

    const incompleteResult = await test.runtime.submit(
      submission("query_nested_incomplete", [incomplete], "nested", test.descriptors.nested),
      principal
    );
    const invalidLeafResult = await test.runtime.submit(
      submission("query_nested_invalid_leaf", [invalidLeaf], "nested", test.descriptors.nested),
      principal
    );

    expect(incompleteResult.result?.status).toBe("FAILED");
    expect(incompleteResult.result?.nodes[0]?.error?.error.code).toBe("SCHEMA_MISMATCH");
    expect(invalidLeafResult.result?.status).toBe("FAILED");
    expect(invalidLeafResult.result?.nodes[0]?.error?.error.code).toBe("SCHEMA_MISMATCH");
    expect(test.nestedCalls()).toBe(0);
  });

  it("rejects unsafe or ambiguous targetPath uses before provider execution", async () => {
    const test = harness();
    const fullRequest = {
      input: {
        geometry: { type: "Point", coordinates: [116.4, 39.9] },
        coordinateSpace: "EPSG:4326",
        coordinateLayout: "XY"
      }
    };
    const nestedRequestPort = schemaPort(test.descriptors.nested.ports.inputs[0]!);
    const geometryLeafPort = canonicalPort(geometryLeafSchemaUri, "GEOMETRY", "ANGULAR_DEGREES");
    const makeRequest = (queryId: string, inputs: Record<string, WorldQueryPlanV2InputBinding>) => {
      const nested = node("nested", test.descriptors.nested, inputs);
      return submission(queryId, [nested], "nested", test.descriptors.nested);
    };

    const wholeRequestTargeted = makeRequest("query_target_whole_request", {
      request: targetedLiteral(fullRequest, nestedRequestPort, "/input")
    });
    const duplicate = makeRequest("query_target_duplicate", {
      first: targetedLiteral({ type: "Point", coordinates: [116.4, 39.9] }, geometryLeafPort, "/input/geometry"),
      second: targetedLiteral({ type: "Point", coordinates: [116.5, 40.0] }, geometryLeafPort, "/input/geometry")
    });
    const ancestor = makeRequest("query_target_ancestor", {
      parent: targetedLiteral({ type: "Point", coordinates: [116.4, 39.9] }, geometryLeafPort, "/input"),
      child: targetedLiteral({ type: "Point", coordinates: [116.5, 40.0] }, geometryLeafPort, "/input/geometry")
    });
    const unsafe = makeRequest("query_target_unsafe", {
      geometry: targetedLiteral({ type: "Point", coordinates: [116.4, 39.9] }, geometryLeafPort, "/input/__proto__/polluted")
    });
    const unsafePrototype = makeRequest("query_target_unsafe_prototype", {
      geometry: targetedLiteral({ type: "Point", coordinates: [116.4, 39.9] }, geometryLeafPort, "/input/prototype/polluted")
    });
    const unsafeConstructor = makeRequest("query_target_unsafe_constructor", {
      geometry: targetedLiteral({ type: "Point", coordinates: [116.4, 39.9] }, geometryLeafPort, "/input/constructor/polluted")
    });
    const reservedSecurityContext = makeRequest("query_target_reserved_security_context", {
      geometry: targetedLiteral(
        { type: "Point", coordinates: [116.4, 39.9] },
        geometryLeafPort,
        "/input/SeCuRiTyCoNtExT/geometry"
      )
    });
    const tooDeep = makeRequest("query_target_too_deep", {
      geometry: targetedLiteral({ type: "Point", coordinates: [116.4, 39.9] }, geometryLeafPort, "/a/b/c/d/e/f/g/h/i")
    });
    const precondition = makeRequest("query_target_precondition", nestedOperandInputs());
    precondition.plan.nodes[0]!.failurePolicy = "SKIP_IF_PRECONDITION_FALSE";
    precondition.plan.nodes[0]!.preconditions = [{
      kind: "VALUE_PRESENT",
      binding: targetedLiteral(
        { type: "Point", coordinates: [116.4, 39.9] },
        geometryLeafPort,
        "/input/geometry"
      )
    }];
    const output = makeRequest("query_target_output", nestedOperandInputs());
    output.plan.outputs[0]!.binding.targetPath = "/answer";

    for (const request of [
      wholeRequestTargeted,
      duplicate,
      ancestor,
      unsafe,
      unsafePrototype,
      unsafeConstructor,
      reservedSecurityContext,
      tooDeep,
      precondition,
      output
    ]) {
      await expect(test.runtime.submit(request, principal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(test.nestedCalls()).toBe(0);
    expect(test.calls).toEqual({ source: 0, sample: 0, fail: 0 });
  });

  it("skips a guarded node when a typed output value does not equal the precondition", async () => {
    const test = harness();
    const source = node("source", test.descriptors.source, literalInput(test.descriptors.source));
    const sample = node(
      "sample",
      test.descriptors.sample,
      linkedInput(test.descriptors.source, test.descriptors.sample, "source"),
      "SKIP_IF_PRECONDITION_FALSE"
    );
    sample.preconditions = [{
      kind: "VALUE_EQUALS",
      value: 999,
      binding: {
        kind: "NODE_OUTPUT",
        nodeId: "source",
        outputPort: "longitude",
        path: "/longitude",
        port: numberPort("ANGULAR_DEGREES")
      }
    }];
    const request = submission("query_value_guard", [source, sample], "sample", test.descriptors.sample);

    const executed = await test.runtime.submit(request, principal);

    expect(executed.result).toMatchObject({
      status: "PARTIAL",
      outputs: {},
      nodes: expect.arrayContaining([expect.objectContaining({ nodeId: "sample", status: "SKIPPED" })])
    });
    expect(test.calls).toMatchObject({ source: 1, sample: 0 });
  });

  it("preserves node/provider error identity while allowing an independent partial result", async () => {
    const test = harness();
    const failing = node("aFail", test.descriptors.fail, literalInput(test.descriptors.fail), "ALLOW_PARTIAL");
    const sample = node("bSample", test.descriptors.sample, literalInput(test.descriptors.sample));
    const request = submission("query_partial", [failing, sample], "bSample", test.descriptors.sample);

    const executed = await test.runtime.submit(request, principal);
    const failed = executed.result?.nodes.find((entry) => entry.nodeId === "aFail");

    expect(executed.result).toMatchObject({ status: "PARTIAL", outputs: { answer: { elevationMeters: 88.5 } } });
    expect(failed).toMatchObject({
      status: "FAILED",
      providerId: "gowm.dag-fixture",
      snapshotAdherence: {
        nodeId: "aFail",
        status: "NOT_APPLICABLE",
        checkedResources: 0,
        mismatches: []
      },
      error: { error: { code: "OVERLOADED", nodeId: "aFail", providerId: "gowm.dag-fixture", retryable: true } }
    });
    expect(executed.result?.snapshotAdherence).toContainEqual(failed?.snapshotAdherence);
    expect(test.calls).toEqual({ source: 0, sample: 1, fail: 1 });
  });

  it("stops downstream nodes under FAIL_FAST", async () => {
    const test = harness();
    const failing = node("aFail", test.descriptors.fail, literalInput(test.descriptors.fail));
    const downstream = node("bDownstream", test.descriptors.source, linkedInput(test.descriptors.fail, test.descriptors.source, "aFail"));
    const request = submission("query_fail_fast", [failing, downstream], "bDownstream", test.descriptors.source);

    const executed = await test.runtime.submit(request, principal);

    expect(executed.result?.status).toBe("FAILED");
    expect(executed.result?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "aFail", status: "FAILED" }),
      expect.objectContaining({ nodeId: "bDownstream", status: "SKIPPED" })
    ]));
    expect(test.calls).toEqual({ source: 0, sample: 0, fail: 1 });
  });

  it("resumes an asynchronously queued plan from a new runtime using persisted nodes", async () => {
    const test = harness(false);
    const source = node("source", test.descriptors.source, literalInput(test.descriptors.source));
    const sample = node("sample", test.descriptors.sample, linkedInput(test.descriptors.source, test.descriptors.sample, "source"));
    const request = submission("query_resume", [source, sample], "sample", test.descriptors.sample);
    const queued = await test.runtime.submit(request, principal, "ASYNC");
    const resumed = new WorldQueryRuntime({
      validator: new QueryPlanValidator(test.registry),
      directExecution: test.direct,
      store: test.store,
      autoRunAsync: false
    });

    expect(queued.job.status).toBe("QUEUED");
    const result = await resumed.run(queued.job.jobId);
    expect(result.status).toBe("COMPLETED");
    expect((await resumed.get("query_resume", principal))?.status).toBe("COMPLETED");
  });

  it("exposes async submit, lookup, cancellation and job lookup routes", async () => {
    const test = harness(false);
    const source = node("source", test.descriptors.source, literalInput(test.descriptors.source));
    const request = submission("query_http", [source], "source", test.descriptors.source);
    const app = buildGatewayApp({
      registry: test.registry,
      directExecution: test.direct,
      records: test.records,
      worldQueries: test.runtime,
      authenticate: async () => principal
    });

    const submitted = await app.inject({
      method: "POST",
      url: "/v1/world-queries",
      headers: { prefer: "respond-async" },
      payload: request
    });
    const jobId = submitted.json().jobId as string;
    const lookup = await app.inject({ method: "GET", url: "/v1/world-queries/query_http" });
    const cancelled = await app.inject({ method: "POST", url: "/v1/world-queries/query_http:cancel" });
    const job = await app.inject({ method: "GET", url: `/v1/jobs/${encodeURIComponent(jobId)}` });

    expect(submitted.statusCode).toBe(202);
    expect(lookup.json().status).toBe("QUEUED");
    expect(cancelled.json().status).toBe("CANCELLED");
    expect(job.json().status).toBe("CANCELLED");
    await app.close();
  });
});
