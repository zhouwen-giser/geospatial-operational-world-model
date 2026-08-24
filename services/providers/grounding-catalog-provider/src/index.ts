import { buildGroundingCatalogApp } from "./app.js";
import { loadGroundingCatalogConfig } from "./config.js";
import { createGroundingCatalogProvider } from "./provider.js";

const config = loadGroundingCatalogConfig();
const provider = createGroundingCatalogProvider(config.provider);
const app = buildGroundingCatalogApp(provider, config.transportToken);

await app.listen({ host: config.host, port: config.port });
console.info(JSON.stringify({
  level: "info",
  message: "Grounding catalog provider listening",
  host: config.host,
  port: config.port,
  providerId: provider.runtime.manifest.provider.providerId,
  operationCount: provider.runtime.manifest.capabilities.length
}));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void Promise.allSettled([app.close(), config.close()]).then((results) => {
      process.exitCode = results.every((result) => result.status === "fulfilled") ? 0 : 1;
    });
  });
}

export { buildGroundingCatalogApp } from "./app.js";
export { loadGroundingCatalogConfig } from "./config.js";
export { createGroundingCatalogProvider } from "./provider.js";
export { GroundingCatalogRepository } from "./repository.js";
export type * from "./types.js";
