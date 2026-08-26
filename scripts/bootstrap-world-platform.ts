import { Pool } from "pg";
import { migrate } from "./migrate.js";
import { persistControlledRegistry } from "./provision-world-platform-registry.js";
import { loadControlledProviderDeployments } from "../services/gateway/world-capability-gateway/src/config.js";

await migrate();
const connectionString = process.env.GATEWAY_REGISTRY_DATABASE_URL;
if (!connectionString) throw new Error("Separate GATEWAY_REGISTRY_DATABASE_URL is required");
const pool = new Pool({ connectionString, max: 1 });
try { await persistControlledRegistry(pool, await loadControlledProviderDeployments("config/world-platform-gateway-registry.json")); }
finally { await pool.end(); }
