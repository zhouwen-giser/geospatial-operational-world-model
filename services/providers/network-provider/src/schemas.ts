import { getContractSchema } from "../../../../packages/platform/contract-runtime/src/index.js";
import type { JsonSchema } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { NetworkOperationId } from "./repository.js";

type Lock = {
  input: string; inputHash: `sha256:${string}`; output: string; outputHash: `sha256:${string}`;
  maturity: "STABLE" | "PREVIEW"; mode: "SYNC" | "SYNC_OR_ASYNC";
};
const SNAP = "sha256:d63fe16bae3534403a320abd21c79d98c9d6914c694cbe810d6773913cf084cb" as const;
const SNAP_RESULT = "sha256:e606e231164ceecdece02310395b6b4742ab45b92d8a9713f196b1779dc257fd" as const;
const BUILD = "sha256:be1fbd02ea7c8c826c910dbbf742bde188ac19037acc419490f1529219dbbe57" as const;
const PATH = "sha256:c4bc84c55f7f67266f99ee799bb8c826d45df2d80ff9ad902e8d1a5669db7794" as const;

export const NETWORK_SCHEMA_LOCKS: Record<NetworkOperationId, Lock> = {
  "network.graph.get": { input: "network-snap-request", inputHash: SNAP, output: "network-graph-version", outputHash: "sha256:947f7f3d6a35b8e3bda52722b16f7e42dc612820c12fbd6a3b1af855dd35411c", maturity: "STABLE", mode: "SYNC" },
  "network.graph.list": { input: "network-snap-request", inputHash: SNAP, output: "network-build-result", outputHash: BUILD, maturity: "STABLE", mode: "SYNC" },
  "network.graph.diagnose": { input: "network-snap-request", inputHash: SNAP, output: "network-build-result", outputHash: BUILD, maturity: "STABLE", mode: "SYNC" },
  "network.snap.point": { input: "network-snap-request", inputHash: SNAP, output: "network-snap-result", outputHash: SNAP_RESULT, maturity: "STABLE", mode: "SYNC" },
  "network.snap.points": { input: "network-snap-request", inputHash: SNAP, output: "network-snap-result", outputHash: SNAP_RESULT, maturity: "STABLE", mode: "SYNC" },
  "network.path.shortest": { input: "network-shortest-path-request", inputHash: "sha256:b1bed7cd90744523d035567b0fbae0382a8fddc014728fef93158cadbdc48355", output: "network-shortest-path-result", outputHash: PATH, maturity: "STABLE", mode: "SYNC" },
  "network.path.cost-matrix": { input: "network-cost-matrix-request", inputHash: "sha256:6dc75cdca2990e8239dd060f1d93bed26959d37ab32507fbc96d92844bda0a55", output: "network-cost-matrix-result", outputHash: "sha256:058346014c99499e53b6b58a2509ef1308c321aad10e4a2525991678824e68f7", maturity: "PREVIEW", mode: "SYNC_OR_ASYNC" },
  "network.path.expand": { input: "network-shortest-path-result", inputHash: PATH, output: "network-shortest-path-result", outputHash: PATH, maturity: "STABLE", mode: "SYNC" },
  "network.path.verify": { input: "network-shortest-path-result", inputHash: PATH, output: "route-verification-report", outputHash: "sha256:76477a2cf770bb5a72208882aa841ac7b13f60e0516a4726ff265efcbdbea8bd", maturity: "STABLE", mode: "SYNC" },
  "network.connectivity.inspect": { input: "network-snap-request", inputHash: SNAP, output: "network-build-result", outputHash: BUILD, maturity: "STABLE", mode: "SYNC" },
  "network.reachability": { input: "network-snap-request", inputHash: SNAP, output: "network-build-result", outputHash: BUILD, maturity: "PREVIEW", mode: "SYNC" }
};

export interface NetworkSchemas {
  input: JsonSchema; output: JsonSchema; inputSchemaUri: string; outputSchemaUri: string;
  inputSchemaHash: `sha256:${string}`; outputSchemaHash: `sha256:${string}`;
}

export function schemasFor(operationId: NetworkOperationId): NetworkSchemas {
  const lock = NETWORK_SCHEMA_LOCKS[operationId];
  const inputSchemaUri = `urn:gowm:v0.5:${lock.input}`;
  const outputSchemaUri = `urn:gowm:v0.5:${lock.output}`;
  return {
    input: getContractSchema(inputSchemaUri), output: getContractSchema(outputSchemaUri), inputSchemaUri, outputSchemaUri,
    inputSchemaHash: lock.inputHash, outputSchemaHash: lock.outputHash
  };
}
