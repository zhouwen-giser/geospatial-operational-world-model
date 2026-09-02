import { parentPort } from "node:worker_threads";
import { asGeometryServiceError, type OperationRequest } from "@geospatial/geometry-contract";
import { GeosWasmAdapter } from "./geos-adapter.js";

if (!parentPort) throw new Error("GEOS worker must run inside worker_threads");

const adapter = new GeosWasmAdapter();
await adapter.initialize();
parentPort.postMessage({ type: "ready", version: adapter.version });

parentPort.on("message", async (message: { id: number; request: OperationRequest }) => {
  try {
    const result = await adapter.execute(message.request);
    parentPort!.postMessage({ type: "result", id: message.id, ok: true, result });
  } catch (error) {
    parentPort!.postMessage({
      type: "result",
      id: message.id,
      ok: false,
      error: asGeometryServiceError(error, message.request.operation).toJSON().error,
    });
  }
});

process.once("beforeExit", () => {
  void adapter.close();
});
