import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createStasProvider } from "./provider.js";
import { buildStasProviderApp } from "./app.js";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";

// STAS keeps its existing independent compiler settings and build output.
const bootstrap = pathToFileURL(resolve("services/stas/dist/platform-adapter-bootstrap.js")).href;
const native = (await import(bootstrap)).createNativePlatformService();
const provider = createStasProvider(native.database, native.service);
const app = buildStasProviderApp(provider.runtime, validateProviderTransportToken(process.env.PROVIDER_TRANSPORT_SHARED_TOKEN), provider.readiness);
const port = Number(process.env.STAS_PROVIDER_PORT ?? "8099");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid STAS_PROVIDER_PORT");
await app.listen({ host: process.env.STAS_PROVIDER_HOST ?? "0.0.0.0", port });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void app.close().then(() => native.database.close());
});
