import type { ProviderExecutionRequest } from "../../packages/platform/contract-runtime/src/index.js";
import {
  createH3AnalysisProvider,
  h3EndpointConfigurationDigest,
  H3ToolkitHttpClient
} from "../../packages/integrations/h3-toolkit-bridge/src/index.js";
import type { DeadlineContext, TraceContext } from "../../packages/platform/provider-sdk/src/index.js";

const baseUrl = process.argv[2] ?? process.env.H3_TOOLKIT_BASE_URL;
if (!baseUrl) throw new Error("Pass the immutable Toolkit API base URL or set H3_TOOLKIT_BASE_URL");
const endpointId = "h3-toolkit-p08-e2e";
const client = new H3ToolkitHttpClient({
  endpointId,
  baseUrl,
  approvalStatus: "APPROVED",
  configurationDigest: h3EndpointConfigurationDigest(endpointId, baseUrl),
  ...(process.env.H3_TOOLKIT_AUTHORIZATION === undefined
    ? {}
    : { authorization: process.env.H3_TOOLKIT_AUTHORIZATION })
});

const readiness = await client.readiness();
if (!readiness.ready) throw new Error(`Toolkit API is not ready: ${readiness.reasons.join("; ")}`);

const point = await client.execute(
  "h3.index.points",
  { points: [{ longitude: 139.7671, latitude: 35.6812 }], resolution: 9 },
  deadline(),
  trace("index")
);
const pointCell = asArray(point.data)[0] as { index?: unknown } | undefined;
if (pointCell?.index !== "892f5a32d97ffff") throw new Error("Toolkit Tokyo R9 self-check differs from the locked Golden cell");

const geometry = tokyoPolygon();
const cover = await client.execute(
  "h3.geometry.cover",
  { geometry, resolution: 9 },
  deadline(),
  trace("cover")
);
if (asArray(cover.data).length === 0) throw new Error("Toolkit cover returned no cells");

await client.execute(
  "h3.neighborhood.disk",
  { cell: "892f5a32d97ffff", radius: 1 },
  deadline(),
  trace("disk")
);
await client.execute(
  "h3.analytics.coverage",
  { area: geometry, resolution: 9, visitedCells: ["892f5a32d97ffff"] },
  deadline(),
  trace("coverage")
);
await client.execute(
  "h3.analytics.flow",
  {
    trajectories: [[
      { longitude: 139.7671, latitude: 35.6812 },
      { longitude: 139.7771, latitude: 35.6912 }
    ]],
    resolution: 9,
    directed: true
  },
  deadline(),
  trace("flow")
);

const analysis = createH3AnalysisProvider({ upstream: client });
const aggregateDescriptor = analysis.runtime.manifest.capabilities.find(
  (capability) => capability.operationId === "h3.analytics.aggregate"
);
if (!aggregateDescriptor) throw new Error("analysis provider omitted aggregate");
const aggregate = await analysis.runtime.execute(providerRequest(aggregateDescriptor));
if (aggregate.dataSnapshot !== undefined || aggregate.evidenceReferences.length !== 0) {
  throw new Error("generic H3 analysis fabricated World data snapshot/evidence");
}

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  sourceGitCommit: readiness.sourceGitCommit,
  toolkitVersion: readiness.toolkitVersion,
  engineVersion: readiness.engineVersion,
  routesExercised: [
    "h3.index.points",
    "h3.geometry.cover",
    "h3.neighborhood.disk",
    "h3.analytics.aggregate",
    "h3.analytics.coverage",
    "h3.analytics.flow"
  ],
  coverCellCount: asArray(cover.data).length,
  providerReceiptCount: aggregate.receipts.length,
  dataSnapshot: "NONE",
  evidenceReferences: 0
})}\n`);

function providerRequest(descriptor: {
  operationId: string;
  operationVersion: string;
  inputSchemaHash: string;
  outputSchemaHash: string;
}): ProviderExecutionRequest {
  const now = Date.now();
  return {
    providerProtocolVersion: "1.0",
    requestId: "request-h3-toolkit-real-e2e",
    gatewayRequestId: "gateway-h3-toolkit-real-e2e",
    idempotencyKey: "idempotency-h3-toolkit-real-e2e",
    operation: {
      operationId: descriptor.operationId,
      operationVersion: descriptor.operationVersion,
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash
    },
    input: {
      records: [{ longitude: 139.7671, latitude: 35.6812, value: 2 }],
      operation: "sum",
      resolution: 9
    },
    securityContext: {
      principalRef: "principal:p08-e2e",
      authenticationMethod: "e2e-attestation",
      authenticatedAt: new Date(now - 120_000).toISOString(),
      scopeAttestation: {
        issuer: "gowm-p08-e2e",
        issuedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 600_000).toISOString(),
        claimDigest: `sha256:${"d".repeat(64)}`
      }
    },
    gatewayContext: {
      gatewayId: "gateway-p08-e2e",
      registryVersion: "p08-e2e/1",
      policyVersion: "p08-e2e/1"
    },
    executionPolicy: {
      deadlineAt: new Date(now + 30_000).toISOString(),
      maximumInputBytes: 64 * 1024 * 1024,
      maximumResultBytes: 128 * 1024 * 1024,
      maximumBatchItems: 100_000,
      maximumVertices: 1_000_000,
      maximumCostClass: "HIGH"
    }
  };
}

function deadline(): DeadlineContext {
  const controller = new AbortController();
  const end = Date.now() + 30_000;
  return {
    signal: controller.signal,
    deadlineAt: new Date(end).toISOString(),
    remainingMs: () => Math.max(0, end - Date.now())
  };
}

function trace(suffix: string): TraceContext {
  return { requestId: `request-h3-${suffix}`, traceId: `trace-h3-${suffix}` };
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Toolkit API result was not an array");
  return value;
}

function tokyoPolygon() {
  return {
    type: "Polygon",
    coordinates: [[[139.75, 35.675], [139.77, 35.675], [139.77, 35.69], [139.75, 35.69], [139.75, 35.675]]]
  };
}
