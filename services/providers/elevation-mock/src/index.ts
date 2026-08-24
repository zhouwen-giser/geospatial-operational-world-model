import { buildElevationMockApp } from "./app.js";
import { createElevationMockProvider } from "./provider.js";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";

const port = Number(process.env.ELEVATION_MOCK_PORT ?? 33010);
const host = process.env.ELEVATION_MOCK_HOST ?? "0.0.0.0";
const app = buildElevationMockApp(
  createElevationMockProvider(),
  validateProviderTransportToken(process.env.PROVIDER_TRANSPORT_SHARED_TOKEN)
);

await app.listen({ port, host });

const stop = async (signal: string) => {
  process.stdout.write(`elevation mock received ${signal}\n`);
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
