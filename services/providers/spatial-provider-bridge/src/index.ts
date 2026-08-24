import { buildSpatialProviderBridgeApp } from "./app.js";
import { loadSpatialBridgeServerConfig } from "./config.js";
import { createSpatialProviderBridge } from "./provider.js";

const config = loadSpatialBridgeServerConfig();
const bridge = createSpatialProviderBridge(config.provider);
const app = buildSpatialProviderBridgeApp(bridge, config.transportToken);

await app.listen({ host: config.host, port: config.port });
console.info(JSON.stringify({
  level: "info",
  message: "Spatial provider bridge listening",
  host: config.host,
  port: config.port,
  providerId: bridge.runtime.manifest.provider.providerId,
  operationCount: bridge.runtime.manifest.capabilities.length
}));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void Promise.allSettled([app.close(), config.close()]).then((results) => {
      process.exitCode = results.every((result) => result.status === "fulfilled") ? 0 : 1;
    });
  });
}

export { buildSpatialProviderBridgeApp } from "./app.js";
export { loadSpatialBridgeServerConfig } from "./config.js";
export { createSpatialProviderBridge } from "./provider.js";
export { GowmSpatialV1Repository } from "./repository.js";
export type * from "./types.js";
