import pg from "pg";
import { resolve } from "node:path";
import { loadControlledProviderDeployments } from "./config.js";
import { synchronizePostgresRegistry } from "./postgres-registry.js";

const databaseUrl = process.env.GATEWAY_REGISTRY_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("GATEWAY_REGISTRY_DATABASE_URL is required for one-shot Registry sync");
const parsed = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
  throw new Error("GATEWAY_REGISTRY_DATABASE_URL must use PostgreSQL");
}
const registryPath = resolve(
  process.env.GATEWAY_PROVIDER_REGISTRY_PATH?.trim() || "config/capability-gateway-registry.json"
);
const pool = new pg.Pool({
  connectionString: databaseUrl,
  application_name: "gowm-capability-registry-bootstrap",
  max: 1,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 5_000
});
pool.on("error", () => process.stderr.write("registry sync postgres pool error\n"));
try {
  const providers = await loadControlledProviderDeployments(registryPath);
  await synchronizePostgresRegistry(pool, providers.map((config) => ({
    config,
    manifest: config.approvedManifest
  })));
  process.stdout.write(JSON.stringify({
    level: "info",
    message: "controlled Provider Registry synchronized",
    providerCount: providers.length
  }) + "\n");
} catch {
  process.stderr.write("controlled Provider Registry synchronization failed\n");
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
