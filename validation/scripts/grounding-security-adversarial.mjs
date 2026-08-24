import assert from "node:assert/strict";

const token = required("PROVIDER_TRANSPORT_SHARED_TOKEN");
const referenceBase = process.env.REFERENCE_PROVIDER_URL ?? "http://127.0.0.1:18090";
const datasetBase = process.env.DATASET_PROVIDER_URL ?? "http://127.0.0.1:18091";
const evidenceBase = process.env.EVIDENCE_PROVIDER_URL ?? "http://127.0.0.1:18093";
const referenceId = process.env.GROUNDING_REFERENCE_ID ?? "wrf_10000000000000000000000000000001";
const datasetId = process.env.GROUNDING_DATASET_ID ?? "wrf_20000000000000000000000000000001";
const layerId = process.env.GROUNDING_LAYER_ID ?? "wrf_22000000000000000000000000000001";
const worldId = process.env.GROUNDING_WORLD_ID ?? "wrf_f5c9c59ef2b0420398f01af385ccbed6";
const resultId = process.env.GROUNDING_RESULT_ID ?? "wrf_4f53a4bbace24a3ca860529e6683f382";
const visibleScope = process.env.GROUNDING_VISIBLE_SCOPE ?? "default";
const hiddenScope = process.env.GROUNDING_HIDDEN_SCOPE ?? "g05-other";
const datasetScope = process.env.GROUNDING_DATASET_SCOPE ?? "tenant-a";
const zeroDigest = `sha256:${"0".repeat(64)}`;
let sequence = Date.now();

const manifests = {
  reference: await manifest(referenceBase, "gowm.reference-catalog"),
  dataset: await manifest(datasetBase, "gowm.dataset-catalog"),
  evidence: await manifest(evidenceBase, "gowm.world-evidence")
};

const referenceKey = key("WORLD_OBJECT", referenceId, "1");
const unknownKey = key("WORLD_OBJECT", "wrf_00000000000000000000000000000000", "1");
const datasetKey = key("DATASET", datasetId, "2026.1");
const layerKey = key("LAYER", layerId, "2026.1");
const worldKey = key("WORLD_OBJECT", worldId, "1");
const resultKey = key("QUERY_RESULT", resultId, "1");

const visibleReference = await execute(referenceBase, manifests.reference, "reference.get", {
  schemaVersion: "1.0", referenceKey
}, { dataScopeClaim: visibleScope });
assert.equal(visibleReference.status, 200);

const hiddenReference = await execute(referenceBase, manifests.reference, "reference.get", {
  schemaVersion: "1.0", referenceKey
}, { dataScopeClaim: hiddenScope });
const unknownReference = await execute(referenceBase, manifests.reference, "reference.get", {
  schemaVersion: "1.0", referenceKey: unknownKey
}, { dataScopeClaim: hiddenScope });
assert.deepEqual(publicError(hiddenReference), publicError(unknownReference));
assert.deepEqual(publicError(hiddenReference), { status: 403, code: "SCOPE_DENIED", message: "reference is unavailable in the authorized scope" });

const ambiguous = await execute(referenceBase, manifests.reference, "reference.resolve", resolveInput("复兴路"), {
  dataScopeClaim: visibleScope
});
const hiddenSearch = await execute(referenceBase, manifests.reference, "reference.resolve", resolveInput("复兴路"), {
  dataScopeClaim: hiddenScope
});
assert.equal(ambiguous.body.output.value.resolutions[0].candidates.length, 2);
assert.equal(hiddenSearch.body.output.value.resolutions[0].status, "UNRESOLVED");
assert.deepEqual(hiddenSearch.body.output.value.resolutions[0].candidates, []);
assert.equal(hiddenSearch.body.consumption.candidates, 0);

const oversized = await execute(referenceBase, manifests.reference, "reference.resolve", resolveInput("x".repeat(513)), {
  dataScopeClaim: visibleScope
});
assert.equal(oversized.status, 422);
assert.equal(oversized.body.error.code, "SCHEMA_MISMATCH");
const injected = await execute(referenceBase, manifests.reference, "reference.resolve", resolveInput("' OR true; SELECT pg_sleep(10); --"), {
  dataScopeClaim: visibleScope
});
assert.equal(injected.status, 200);
const stillHealthy = await fetch(`${referenceBase}/health/ready`);
assert.equal(stillHealthy.status, 200);

const hiddenDataset = await execute(datasetBase, manifests.dataset, "dataset.get", {
  schemaVersion: "1.0", referenceKey: datasetKey
}, { dataScopeClaim: hiddenScope, datasetScopeClaim: datasetScope });
const unknownDataset = await execute(datasetBase, manifests.dataset, "dataset.get", {
  schemaVersion: "1.0", referenceKey: key("DATASET", unknownKey.id, "2026.1")
}, { dataScopeClaim: hiddenScope, datasetScopeClaim: datasetScope });
assert.deepEqual(publicError(hiddenDataset), publicError(unknownDataset));

const featurePage = await execute(datasetBase, manifests.dataset, "layer.find-features", {
  schemaVersion: "1.0", referenceKey: layerKey, limit: 1
}, { dataScopeClaim: visibleScope, datasetScopeClaim: datasetScope });
assert.equal(featurePage.status, 200);
assert.ok(featurePage.body.output.value.nextCursor);
const cursor = featurePage.body.output.value.nextCursor;
for (const candidate of [
  `${cursor}x`,
  `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`
]) {
  const tampered = await execute(datasetBase, manifests.dataset, "layer.find-features", {
    schemaVersion: "1.0", referenceKey: layerKey, limit: 1, cursor: candidate
  }, { dataScopeClaim: visibleScope, datasetScopeClaim: datasetScope });
  assert.equal(tampered.status, 422);
  assert.equal(tampered.body.error.code, "INVALID_REQUEST");
}
const wrongScopeCursor = await execute(datasetBase, manifests.dataset, "layer.find-features", {
  schemaVersion: "1.0", referenceKey: layerKey, limit: 1, cursor
}, { dataScopeClaim: hiddenScope, datasetScopeClaim: datasetScope });
assert.equal(wrongScopeCursor.status, 422);
assert.equal(wrongScopeCursor.body.error.code, "INVALID_REQUEST");
const wrongOperationCursor = await execute(datasetBase, manifests.dataset, "layer.list", {
  schemaVersion: "1.0", limit: 1, cursor
}, { dataScopeClaim: visibleScope, datasetScopeClaim: datasetScope });
assert.equal(wrongOperationCursor.status, 422);

const observationPage = await execute(evidenceBase, manifests.evidence, "world.get-observations", {
  schemaVersion: "1.0", referenceKey: worldKey, limit: 1
}, { dataScopeClaim: visibleScope });
assert.equal(observationPage.status, 200, JSON.stringify(observationPage.body));
const evidenceCursor = observationPage.body.output.value.nextCursor;
assert.ok(evidenceCursor);
const wrongEvidenceScope = await execute(evidenceBase, manifests.evidence, "world.get-observations", {
  schemaVersion: "1.0", referenceKey: worldKey, limit: 1, cursor: evidenceCursor
}, { dataScopeClaim: hiddenScope });
assert.equal(wrongEvidenceScope.status, 422);
assert.equal(wrongEvidenceScope.body.error.code, "INVALID_REQUEST");

const hiddenResult = await execute(evidenceBase, manifests.evidence, "result.get", {
  schemaVersion: "1.0", referenceKey: resultKey
}, { dataScopeClaim: hiddenScope });
const unknownResult = await execute(evidenceBase, manifests.evidence, "result.get", {
  schemaVersion: "1.0", referenceKey: key("QUERY_RESULT", unknownKey.id, "1")
}, { dataScopeClaim: hiddenScope });
assert.deepEqual(publicError(hiddenResult), publicError(unknownResult));

const unauthorized = await fetch(`${referenceBase}/v1/operations/reference.get:execute`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}"
});
assert.equal(unauthorized.status, 403);

process.stdout.write(`${JSON.stringify({
  result: "GROUNDING_SECURITY_ADVERSARIAL_PASS",
  providers: Object.values(manifests).map((value) => value.provider.providerId),
  scopeOpaqueReference: true,
  scopeOpaqueDataset: true,
  scopeOpaqueResult: true,
  hiddenCandidateCount: 0,
  boundedInputRejected: true,
  injectionRemainedData: true,
  signedCursorTamperingRejected: true,
  cursorScopeAndOperationBound: true,
  unauthenticatedTransportRejected: true
}, null, 2)}\n`);

async function manifest(base, expectedProviderId) {
  const response = await fetch(`${base}/v1/manifest`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider.providerId, expectedProviderId);
  return body;
}

async function execute(base, providerManifest, operationId, input, scopes) {
  const descriptor = providerManifest.capabilities.find((candidate) => candidate.operationId === operationId);
  assert.ok(descriptor, `${operationId} missing from manifest`);
  sequence += 1;
  const now = new Date();
  const deadlineAt = new Date(now.getTime() + 30_000).toISOString();
  const response = await fetch(`${base}/v1/operations/${operationId}:execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      providerProtocolVersion: "1.0",
      requestId: `g07_request_${sequence}`,
      gatewayRequestId: `g07_gateway_${sequence}`,
      idempotencyKey: `g07-idempotency-${sequence}`,
      operation: {
        operationId,
        operationVersion: descriptor.operationVersion,
        inputSchemaHash: descriptor.inputSchemaHash,
        outputSchemaHash: descriptor.outputSchemaHash
      },
      input,
      securityContext: {
        principalRef: "principal:g07-adversarial",
        authenticationMethod: "TEST_ATTESTED",
        authenticatedAt: now.toISOString(),
        ...scopes,
        scopeAttestation: { issuer: "gateway-g07", issuedAt: now.toISOString(), expiresAt: deadlineAt, claimDigest: zeroDigest }
      },
      gatewayContext: { gatewayId: "gateway-g07", registryVersion: "g07", policyVersion: "g07" },
      executionPolicy: { deadlineAt, maximumInputBytes: 1_048_576, maximumResultBytes: 16_777_216, maximumCostClass: "MEDIUM" }
    })
  });
  return { status: response.status, body: await response.json() };
}

function resolveInput(surfaceText) {
  return {
    schemaVersion: "1.0",
    mentions: [{ mentionId: "g07-mention", surfaceText, expectedKinds: ["WORLD_OBJECT"] }],
    context: { anchorReferenceKeys: [] },
    limitPerMention: 20
  };
}

function publicError(response) {
  return { status: response.status, code: response.body.error.code, message: response.body.error.message };
}

function key(kind, id, version) {
  return { namespace: "gowm", kind, id, version };
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
