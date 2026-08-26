import { Pool } from "pg";
import { buildProviderProtocolApp, validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";
import { NetworkRepository } from "../../../../packages/network-query-core/src/index.js";
import { createRoadCoverageProvider, PostgresRoadCoverageEngine } from "./provider.js";

const databaseUrl = process.env.COVERAGE_PROVIDER_DATABASE_URL;
if (!databaseUrl) throw new Error("COVERAGE_PROVIDER_DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000 });
const provider = createRoadCoverageProvider(new PostgresRoadCoverageEngine({ pool }));
const network = new NetworkRepository({ pool });
const app = buildProviderProtocolApp(provider.runtime, validateProviderTransportToken(process.env.PROVIDER_TRANSPORT_SHARED_TOKEN), async () => {
  try {
    const networkState = await network.readiness();
    const permission = await pool.query<{allowed:boolean}>("SELECT has_function_privilege(current_user,'coverage_planner.get_coverage_result(uuid,text,text)','EXECUTE') AS allowed");
    if (permission.rows[0]?.allowed !== true) throw new Error("coverage runtime privilege unavailable");
    return networkState;
  } catch { return { ready: false, reasons: ["coverage runtime database contract unavailable"] }; }
});
const port = Number(process.env.COVERAGE_PROVIDER_PORT ?? "8098");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid COVERAGE_PROVIDER_PORT");
await app.listen({ host: process.env.COVERAGE_PROVIDER_HOST ?? "0.0.0.0", port });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close().then(() => pool.end()); });
