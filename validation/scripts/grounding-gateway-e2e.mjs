import assert from "node:assert/strict";

const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:18080";
const token = required("GATEWAY_AUTH_SHARED_TOKEN");
const mode = process.env.G08_MODE ?? "initial";
const deadlineAt = required("G08_DEADLINE_AT");
const runId = process.env.G08_RUN_ID ?? "g08-grounding-ready";
const worldId = process.env.GROUNDING_WORLD_ID ?? "wrf_f5c9c59ef2b0420398f01af385ccbed6";
const datasetId = process.env.GROUNDING_DATASET_ID ?? "wrf_20000000000000000000000000000001";
const parameterSchemaHash = "sha256:12435544345b96060988d2260be7d2cd3356df710442023888a8c02911c26c97";
const stringPort = {
  schemaUri: "urn:gowm:v0.2:value:string",
  schemaHash: "sha256:a71d355802de7ff21b9c9d9214a1ba71b3648866bcf1b7c0f4ff3b656485c6d5",
  valueKind: "SCALAR",
  unitSemantics: "UNSPECIFIED"
};
const referencePort = {
  schemaUri: "urn:gowm:v0.4:reference-key",
  schemaHash: "sha256:240470501ee453cf97ce536b62b81ce2a32efc6cf01d02accab0a88b7ca2a403",
  valueKind: "REFERENCE_KEY",
  unitSemantics: "UNSPECIFIED"
};

const healthResponse = await fetch(`${base}/health`);
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.status, "ok", JSON.stringify(health));
assert.equal(Object.keys(health.providers).length, 3);
assert.ok(Object.values(health.providers).every((value) => value.ready));

const catalogResponse = await fetch(`${base}/v1/capabilities`);
assert.equal(catalogResponse.status, 200);
const catalog = await catalogResponse.json();
assert.equal(catalog.capabilities.length, 20);
const descriptor = (operationId) => {
  const value = catalog.capabilities.find((candidate) => candidate.operationId === operationId);
  assert.ok(value, `${operationId} missing from Gateway catalog`);
  return value;
};

const restartDescriptor = descriptor("world.get-current-state");
const restartRequest = gatewayRequest(`${runId}-restart`, restartDescriptor, {
  schemaVersion: "1.0",
  referenceKey: { namespace: "gowm", kind: "WORLD_OBJECT", id: worldId, version: "1" }
});
if (mode === "restart") {
  const replay = await direct("world.get-current-state", restartRequest);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.output.value.facts[0].fields.status, "AVAILABLE");
  process.stdout.write(`${JSON.stringify({
    result: "GROUNDING_GATEWAY_RESTART_REPLAY_PASS",
    registryVersion: catalog.registryVersion,
    capabilityCount: catalog.capabilities.length,
    durableReplay: true
  }, null, 2)}\n`);
  process.exit(0);
}

const resolveDescriptor = descriptor("reference.resolve");
const resolveRequest = gatewayRequest(`${runId}-resolve`, resolveDescriptor, {
  schemaVersion: "1.0",
  mentions: [{ mentionId: "road", surfaceText: "ROAD-001", expectedKinds: ["WORLD_OBJECT"] }],
  context: { anchorReferenceKeys: [] },
  limitPerMention: 10
});
const resolved = await direct("reference.resolve", resolveRequest);
assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
assert.equal(resolved.replayed, false);
assert.equal(resolved.body.output.value.resolutions[0].status, "RESOLVED_EXACT");
const resolvedReplay = await direct("reference.resolve", resolveRequest);
assert.equal(resolvedReplay.replayed, true);
assert.deepEqual(resolvedReplay.body, resolved.body);

const datasetDescriptor = descriptor("dataset.get");
const dataset = await direct("dataset.get", gatewayRequest(`${runId}-dataset`, datasetDescriptor, {
  schemaVersion: "1.0",
  referenceKey: { namespace: "gowm", kind: "DATASET", id: datasetId, version: "2026.1" }
}));
assert.equal(dataset.status, 200, JSON.stringify(dataset.body));
assert.equal(dataset.body.output.value.currentVersion, "2026.1");

const current = await direct("world.get-current-state", restartRequest);
assert.equal(current.status, 200, JSON.stringify(current.body));
assert.equal(current.replayed, false);
assert.equal(current.body.output.value.facts[0].fields.status, "AVAILABLE");
assert.equal(current.body.output.value.worldVersion, 11);

const injected = structuredClone(restartRequest);
injected.idempotencyKey = `${runId}-scope-injection`;
injected.requestId = `${runId}-scope-injection`;
injected.dataScopeClaim = "g05-other";
const injectionResponse = await direct("world.get-current-state", injected);
assert.equal(injectionResponse.status, 422);
assert.equal(injectionResponse.body.error.code, "INVALID_REQUEST");

const resolveOutputPort = resolveDescriptor.ports.outputs.find((port) => port.name === "candidateReferenceKey");
assert.deepEqual(resolveOutputPort, {
  name: "candidateReferenceKey",
  path: "/resolutions/0/candidates/0/candidate/referenceKey",
  ...referencePort
});
const currentInput = currentDescriptorInput(restartDescriptor);
const currentOutput = restartDescriptor.ports.outputs.find((port) => port.name === "result");
assert.ok(currentOutput);
const dagSubmission = {
  requestId: `${runId}-dag-request`,
  idempotencyKey: `${runId}-dag-idempotency`,
  parameterSchemaHash,
  parameters: {},
  plan: {
    queryPlanVersion: "2.0",
    queryId: `${runId}-dag`,
    nodes: [
      {
        nodeId: "resolveRoad",
        operation: operationRef(resolveDescriptor),
        inputs: {
          request: { kind: "LITERAL", port: currentDescriptorInput(resolveDescriptor), value: resolveRequest.input }
        },
        failurePolicy: "FAIL_FAST",
        budget: nodeBudget(10, 20)
      },
      {
        nodeId: "currentState",
        operation: operationRef(restartDescriptor),
        inputs: {
          schemaVersion: { kind: "LITERAL", port: stringPort, value: "1.0", targetPath: "/schemaVersion" },
          referenceKey: {
            kind: "NODE_OUTPUT",
            port: referencePort,
            nodeId: "resolveRoad",
            outputPort: "candidateReferenceKey",
            path: resolveOutputPort.path,
            targetPath: "/referenceKey"
          }
        },
        failurePolicy: "FAIL_FAST",
        budget: nodeBudget(100, 100)
      }
    ],
    outputs: [{
      name: "groundedState",
      binding: { kind: "NODE_OUTPUT", nodeId: "currentState", outputPort: "result", port: portShape(currentOutput) }
    }],
    budgets: {
      maximumNodes: 2,
      maximumDepth: 2,
      maximumRows: 110,
      maximumCandidates: 120,
      maximumOutputBytes: 1_048_576,
      maximumExecutionMs: 20_000
    }
  }
};
const dag = await worldQuery(dagSubmission);
assert.equal(dag.status, 200, JSON.stringify(dag.body));
assert.equal(dag.replayed, false);
assert.equal(dag.body.status, "PARTIAL");
assert.deepEqual(dag.body.nodes.map((node) => node.status), ["COMPLETED", "NO_DATA"]);
assert.equal(dag.body.outputs.groundedState.facts.length, 0);
assert.ok(dag.body.outputs.groundedState.unknowns.includes("CURRENT_STATE_UNAVAILABLE"));
const dagReplay = await worldQuery(dagSubmission);
assert.equal(dagReplay.replayed, true);
assert.deepEqual(dagReplay.body, dag.body);

process.stdout.write(`${JSON.stringify({
  result: "GROUNDING_READY",
  registryVersion: catalog.registryVersion,
  providerCount: Object.keys(health.providers).length,
  capabilityCount: catalog.capabilities.length,
  directRoutes: ["reference.resolve", "dataset.get", "world.get-current-state"],
  directIdempotentReplay: true,
  dag: "reference.resolve -> world.get-current-state",
  dagStatus: dag.body.status,
  dagNoDataPreserved: true,
  dagIdempotentReplay: true,
  publicScopeInjectionRejected: true,
  restartFixtureCreated: true
}, null, 2)}\n`);

function gatewayRequest(id, operation, input) {
  return {
    requestVersion: "1.0",
    requestId: id,
    idempotencyKey: id,
    operationVersion: operation.operationVersion,
    inputSchemaHash: operation.inputSchemaHash,
    outputSchemaHash: operation.outputSchemaHash,
    input,
    executionPolicy: {
      deadlineAt,
      maximumResultBytes: 16_777_216,
      maximumRows: operation.limits.maximumRows,
      maximumCandidates: operation.limits.maximumCandidates,
      maximumCostClass: "MEDIUM",
      preferredExecution: "SYNC"
    }
  };
}

async function direct(operationId, body) {
  const response = await fetch(`${base}/v1/operations/${operationId}:execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, replayed: response.headers.get("idempotent-replay") === "true", body: await response.json() };
}

async function worldQuery(body) {
  const response = await fetch(`${base}/v1/world-queries`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, replayed: response.headers.get("idempotent-replay") === "true", body: await response.json() };
}

function operationRef(operation) {
  return {
    operationId: operation.operationId,
    operationVersion: operation.operationVersion,
    inputSchemaHash: operation.inputSchemaHash,
    outputSchemaHash: operation.outputSchemaHash
  };
}

function currentDescriptorInput(operation) {
  const port = operation.ports.inputs.find((candidate) => candidate.name === "request");
  assert.ok(port);
  return portShape(port);
}

function portShape(port) {
  return {
    schemaUri: port.schemaUri,
    schemaHash: port.schemaHash,
    valueKind: port.valueKind,
    unitSemantics: port.unitSemantics
  };
}

function nodeBudget(maximumRows, maximumCandidates) {
  return { maximumRows, maximumCandidates, maximumOutputBytes: 524_288, maximumExecutionMs: 10_000 };
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
