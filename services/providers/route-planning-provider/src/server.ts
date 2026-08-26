import { Pool } from "pg";
import { buildProviderProtocolApp, validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";
import { createRoutePlanningProvider } from "./provider.js";

const databaseUrl = process.env.ROUTE_PROVIDER_DATABASE_URL;
if (!databaseUrl) throw new Error("ROUTE_PROVIDER_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000 });
const provider = createRoutePlanningProvider({ pool });
const app = buildProviderProtocolApp(provider.runtime, validateProviderTransportToken(process.env.PROVIDER_TRANSPORT_SHARED_TOKEN), () => provider.planner.network.readiness());
const port = Number(process.env.ROUTE_PROVIDER_PORT ?? "8097");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid ROUTE_PROVIDER_PORT");
await app.listen({ host: process.env.ROUTE_PROVIDER_HOST ?? "0.0.0.0", port });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => pool.end()); });
