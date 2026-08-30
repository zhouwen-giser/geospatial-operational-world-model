import { buildHistoricalTraceApp } from "./app.js";
import { loadHistoricalTraceConfig } from "./config.js";
import { createHistoricalTraceProvider } from "./provider.js";

const config = loadHistoricalTraceConfig();
const provider = createHistoricalTraceProvider({ pool: config.pool });
const app = buildHistoricalTraceApp(provider, config.transportToken);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await Promise.allSettled([app.close(), config.close()]);
  throw error;
}

console.info(JSON.stringify({
  level: "info",
  message: "Historical Trace Provider listening",
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
