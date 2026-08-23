import { buildGowmSituationProviderApp } from "./app.js";
import { loadGowmSituationServerConfig } from "./config.js";
import { createGowmSituationProvider } from "./provider.js";

const config = loadGowmSituationServerConfig();
const provider = createGowmSituationProvider(config.provider);
const app = buildGowmSituationProviderApp(provider, config.transportToken);

await app.listen({ host: config.host, port: config.port });
console.info(JSON.stringify({
  level: "info",
  message: "GOWM Situation provider listening",
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

export { buildGowmSituationProviderApp } from "./app.js";
export { createGowmSituationProvider, GOWM_SITUATION_METRIC_PROFILE } from "./provider.js";
export { RepositorySituationReadPort } from "./repository-adapter.js";
export type * from "./types.js";
