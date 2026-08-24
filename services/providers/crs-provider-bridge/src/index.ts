import { buildCrsProviderBridgeApp } from "./app.js";
import { loadCrsBridgeServerConfig } from "./config.js";
import { createCrsProviderBridge } from "./provider.js";

const config = loadCrsBridgeServerConfig();
const bridge = createCrsProviderBridge(config.provider);
const app = buildCrsProviderBridgeApp(bridge, config.transportToken);

await app.listen({ host: config.host, port: config.port });
console.info(JSON.stringify({
  level: "info",
  message: "CRS provider bridge listening",
  host: config.host,
  port: config.port,
  providerId: bridge.runtime.manifest.provider.providerId,
  operationCount: bridge.runtime.manifest.capabilities.length
}));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(
      () => { process.exitCode = 0; },
      () => { process.exitCode = 1; }
    );
  });
}

export { buildCrsProviderBridgeApp } from "./app.js";
export { loadCrsBridgeServerConfig } from "./config.js";
export { createCrsProviderBridge } from "./provider.js";
export { endpointConfigurationDigest } from "./upstream-client.js";
export type * from "./types.js";
