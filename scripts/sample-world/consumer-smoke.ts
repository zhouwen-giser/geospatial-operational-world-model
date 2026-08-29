import { randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DelegationTokenClaims } from "../../packages/platform/contract-runtime/src/index.js";

type AnyRecord = Record<string, any>;

const baseUrl = required("GOWM_GATEWAY_BASE_URL").replace(/\/$/u, "");
const outputDirectory = resolve(process.env.SAMPLE_WORLD_OUTPUT_DIRECTORY ?? "/runtime/output");
const privateKeyPath = required("GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH");

async function main(): Promise<void> {
  const ready = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(15_000) });
  if (!ready.ok) throw new Error(`Consumer-side Gateway readiness failed: HTTP ${ready.status}`);

  const [catalogResponse, semanticsResponse] = await Promise.all([
    fetch(`${baseUrl}/v1/capabilities`, { signal: AbortSignal.timeout(30_000) }),
    fetch(`${baseUrl}/v1/capability-semantics`, { signal: AbortSignal.timeout(30_000) })
  ]);
  if (!catalogResponse.ok || !semanticsResponse.ok) throw new Error("Consumer-side contract discovery failed");
  const catalog = await catalogResponse.json() as AnyRecord;
  const semantics = await semanticsResponse.json() as AnyRecord;
  const instanceManifest = JSON.parse(await readFile(resolve(outputDirectory, "INSTANCE_MANIFEST.json"), "utf8")) as AnyRecord;
  const instanceBinding = JSON.parse(await readFile(resolve(outputDirectory, "INSTANCE_BINDING.json"), "utf8")) as AnyRecord;
  if (instanceManifest.runtimeInstanceId !== instanceBinding.runtimeInstanceId ||
      instanceManifest.instanceId !== instanceBinding.instanceId ||
      catalog.contractCatalogRevision !== instanceManifest.contractCatalogRevision ||
      semantics.contractCatalogRevision !== instanceManifest.contractCatalogRevision ||
      semantics.catalogHash !== instanceManifest.semanticCatalogHash ||
      catalog.bindingRevision !== instanceBinding.bindingRevision) {
    throw new Error("Consumer-side live contract binding differs from the handoff");
  }
  const descriptor = (catalog.capabilities as AnyRecord[] | undefined)?.find((candidate) =>
    candidate.operationId === "reference.get" && candidate.operationVersion === "1.0"
  );
  if (!descriptor || descriptor.maturity !== "STABLE") throw new Error("Consumer-side reference.get@1.0 is unavailable");

  const referenceMap = JSON.parse(await readFile(resolve(outputDirectory, "SAMPLE_REFERENCE_MAP.json"), "utf8")) as AnyRecord;
  if (referenceMap.realizationId !== instanceBinding.realizationId) {
    throw new Error("Consumer-side ReferenceMap realization differs from the handoff binding");
  }
  const ugv2 = (referenceMap.entries as AnyRecord[] | undefined)?.find((entry) => entry.fixtureKey === "ugv-002");
  const referenceKey = ugv2?.currentWorldReferenceKey ?? ugv2?.identityReferenceKey;
  if (!referenceKey) throw new Error("Consumer-side sample ReferenceMap has no ugv-002");

  const requestId = `wsgs-consumer-smoke-${randomUUID()}`;
  const request = {
    requestVersion: "1.0",
    requestId,
    idempotencyKey: requestId,
    operationVersion: "1.0",
    inputSchemaHash: descriptor.inputSchemaHash,
    outputSchemaHash: descriptor.outputSchemaHash,
    input: { schemaVersion: "1.0", referenceKey },
    executionPolicy: {
      deadlineAt: new Date(Date.now() + Math.min(60_000, descriptor.execution.maximumTimeoutMs)).toISOString(),
      maximumResultBytes: descriptor.limits.maximumOutputBytes,
      maximumRows: descriptor.limits.maximumRows ?? 100,
      maximumCandidates: descriptor.limits.maximumCandidates ?? 100,
      maximumCostClass: descriptor.execution.costClass,
      preferredExecution: "SYNC"
    }
  };
  const now = Math.floor(Date.now() / 1_000);
  const claims: DelegationTokenClaims = {
    iss: required("GATEWAY_DELEGATION_ISSUER"),
    sub: required("GATEWAY_RUNTIME_PRINCIPAL_REF"),
    aud: required("GATEWAY_DELEGATION_AUDIENCE"),
    iat: now - 1,
    nbf: now - 1,
    exp: now + 120,
    jti: `wsgs-consumer-smoke-${randomUUID()}`,
    act: { sub: "actor:wsgs-container-smoke" },
    requestId,
    delegationDepth: 1,
    dataScopes: [required("GATEWAY_DATA_SCOPE_CLAIM")],
    datasetScopes: [required("GATEWAY_DATASET_SCOPE_CLAIM")],
    allowedOperations: ["reference.get@1.0"]
  };
  const response = await fetch(`${baseUrl}/v1/operations/reference.get:execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${required("GOWM_WSGS_SAMPLE_TOKEN")}`,
      "content-type": "application/json",
      "x-request-id": requestId,
      "x-gowm-delegation": compactJws(claims, await readFile(privateKeyPath, "utf8"))
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(60_000)
  });
  const body = await response.json() as AnyRecord;
  if (response.status !== 200 || body.status !== "COMPLETED" || body.output?.value === undefined ||
      !JSON.stringify(body.output.value).includes(String(referenceKey.id))) {
    throw new Error(`Consumer-side signed reference.get failed: HTTP ${response.status}`);
  }
  process.stdout.write("INDEPENDENT_CONSUMER_CONTAINER_CONNECTIVITY_PASS auth=SIGNED_DELEGATION_V1 operation=reference.get@1.0\n");
}

function compactJws(claims: DelegationTokenClaims, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), privateKey).toString("base64url")}`;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
