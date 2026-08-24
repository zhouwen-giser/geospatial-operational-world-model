import { buildNetworkProviderApp } from "./app.js";
import { loadNetworkProviderConfig } from "./config.js";
import { createNetworkProvider } from "./provider.js";

const config = loadNetworkProviderConfig();
const provider = createNetworkProvider(config.provider);
const app = buildNetworkProviderApp(provider, config.transportToken);
await app.listen({ host: config.host, port: config.port });
console.info(JSON.stringify({ level: "info", message: "Network provider listening", host: config.host, port: config.port, providerId: "gowm.network", operationCount: provider.runtime.manifest.capabilities.length }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void Promise.allSettled([app.close(), config.close()]).then((results) => { process.exitCode = results.every((result) => result.status === "fulfilled") ? 0 : 1; }); });

export { buildNetworkProviderApp } from "./app.js";
export { loadNetworkProviderConfig } from "./config.js";
export { createNetworkProvider } from "./provider.js";
export { NetworkRepository } from "./repository.js";
export type * from "./types.js";
