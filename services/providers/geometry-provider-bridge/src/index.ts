import { buildGeometryProviderBridgeApp } from "./app.js";
import { loadGeometryBridgeServerConfig } from "./config.js";
import { createGeometryProviderBridge } from "./provider.js";

const config = loadGeometryBridgeServerConfig();
const bridge = createGeometryProviderBridge(config.provider);
const app = buildGeometryProviderBridgeApp(bridge, config.transportToken);

await app.listen({ host: config.host, port: config.port });

const close = async (): Promise<void> => {
  await app.close();
  process.exitCode = 0;
};

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
