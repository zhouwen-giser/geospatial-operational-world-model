import { buildPlatformValidationApp } from "./app.js";
import { loadPlatformValidationConfig } from "./config.js";
import { createPlatformValidationProvider } from "./index.js";

const config = loadPlatformValidationConfig();
const provider = createPlatformValidationProvider(config.authority);
const app = buildPlatformValidationApp(provider, config.transportToken);
await app.listen({ host: config.host, port: config.port });
process.stdout.write(`${JSON.stringify({ level: "info", message: "Platform Validation Provider listening", host: config.host, port: config.port, providerId: provider.runtime.manifest.provider.providerId, operationCount: provider.runtime.manifest.capabilities.length })}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void Promise.allSettled([app.close(), config.close()]).then((results) => { process.exitCode = results.every((result) => result.status === "fulfilled") ? 0 : 1; }); });
}
