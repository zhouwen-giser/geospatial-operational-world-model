import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const composePaths = ["docker-compose.yml", "docker-compose.world-platform.yml", "docker-compose.dev.yml"];
const examplePath = ".env.example";
const composeVariables = new Set();

for (const path of composePaths) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/\$\{([A-Z][A-Z0-9_]*)/gu)) composeVariables.add(match[1]);
}

const example = await readFile(examplePath, "utf8");
const exampleVariables = new Set(
  example.split(/\r?\n/u)
    .map((line) => /^([A-Z][A-Z0-9_]*)=/u.exec(line)?.[1])
    .filter(Boolean)
);

const worldExampleVariables = new Set(
  (await readFile(".env.world-platform.example", "utf8")).split(/\r?\n/u)
    .map((line) => /^([A-Z][A-Z0-9_]*)=/u.exec(line)?.[1])
    .filter(Boolean)
);

const ignoredContainerVariables = new Set(["PGDATA"]);
const missing = [...composeVariables]
  .filter((name) => !ignoredContainerVariables.has(name) && !exampleVariables.has(name))
  .sort();

const derivedRuntimeVariables = new Set([
  "CAPABILITY_GATEWAY_AUTHORIZATION", "CAPABILITY_GATEWAY_URL",
  "COVERAGE_PROVIDER_DATABASE_URL", "COVERAGE_PROVIDER_HOST", "COVERAGE_PROVIDER_PORT",
  "CRS_BRIDGE_ENDPOINT_APPROVAL_STATUS", "CRS_BRIDGE_ENDPOINT_ID", "CRS_BRIDGE_GRID_BUNDLE_VERSION",
  "CRS_BRIDGE_HOST", "CRS_BRIDGE_INTEGRATION_VERSION", "CRS_BRIDGE_PORT", "CRS_BRIDGE_PROJ_DB_VERSION",
  "CRS_BRIDGE_PROJ_VERSION", "CRS_BRIDGE_UPSTREAM_BASE_URL", "CRS_GDAL_MODULE_PATH",
  "ELEVATION_MOCK_HOST", "ELEVATION_MOCK_PORT", "GATEWAY_CANONICAL_SCHEMA_LOCK_PATH",
  "GATEWAY_CANONICAL_SCHEMA_ROOT_PATH", "GATEWAY_HOST", "GATEWAY_PROVIDER_REGISTRY_PATH",
  "GATEWAY_REGISTRY_DATABASE_URL", "GEOMETRY_BRIDGE_ENDPOINT_APPROVAL_STATUS",
  "GEOMETRY_BRIDGE_ENDPOINT_ID", "GEOMETRY_BRIDGE_GEOS_VERSION", "GEOMETRY_BRIDGE_HOST",
  "GEOMETRY_BRIDGE_INTEGRATION_VERSION", "GEOMETRY_BRIDGE_MAX_IN_FLIGHT",
  "GEOMETRY_BRIDGE_MAX_QUEUE_SIZE", "GEOMETRY_BRIDGE_PORT", "GEOMETRY_BRIDGE_UPSTREAM_BASE_URL",
  "GEOMETRY_ENGINE", "GEOMETRY_EXECUTION", "GEOMETRY_MAX_WORKER_QUEUE", "GOWM_DATA_SCOPE",
  "GOWM_SITUATION_ACCEPTED_DATA_SCOPE", "GOWM_SITUATION_PROVIDER_HOST", "GOWM_SITUATION_PROVIDER_PORT",
  "GROUNDING_CATALOG_CURSOR_HMAC_SECRET", "GROUNDING_CATALOG_DATABASE_URL", "GROUNDING_CATALOG_HOST",
  "GROUNDING_CATALOG_MODE", "GROUNDING_CATALOG_PORT", "H3_ANALYSIS_PROVIDER_HOST",
  "H3_ANALYSIS_PROVIDER_PORT", "H3_INTERACTIVE_PROVIDER_HOST", "H3_INTERACTIVE_PROVIDER_PORT",
  "H3_PROVIDER_HOST", "H3_PROVIDER_PORT",
  "H3_TOOLKIT_AUTHORIZATION", "H3_TOOLKIT_BASE_URL", "H3_TOOLKIT_BINDINGS_MODULE", "H3_TOOLKIT_ENDPOINT_ID",
  "HISTORICAL_TRACE_DATABASE_URL", "HISTORICAL_TRACE_HOST", "HISTORICAL_TRACE_PORT",
  "HISTORICAL_WORKER_DATABASE_URL", "HOST", "HOSTNAME", "NETWORK_PROVIDER_DATABASE_URL",
  "NETWORK_PROVIDER_HOST", "NETWORK_PROVIDER_PORT", "OPERATIONAL_REALITY_DATABASE_URL",
  "OPERATIONAL_REALITY_HOST", "OPERATIONAL_REALITY_PORT", "PLATFORM_VALIDATION_DATABASE_URL",
  "PLATFORM_VALIDATION_HOST", "PLATFORM_VALIDATION_PORT", "PORT", "POSTGIS_URL", "PROJ_NETWORK",
  "PROJ_ONLY_BEST_DEFAULT", "PROVIDER_TRANSPORT_SHARED_TOKEN", "ROUTE_PROVIDER_DATABASE_URL",
  "ROUTE_PROVIDER_HOST", "ROUTE_PROVIDER_PORT", "SPATIAL_BRIDGE_HOST", "SPATIAL_BRIDGE_PORT",
  "SPATIAL_DATABASE_URL", "STAS_PROVIDER_HOST", "STAS_PROVIDER_PORT"
]);

async function sourceFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["node_modules", "dist", "test", "tests"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) result.push(path);
  }
  return result;
}

const runtimeVariables = new Set();
for (const root of ["services", "packages", "simulator"]) {
  for (const path of await sourceFiles(root)) {
    const source = await readFile(path, "utf8");
    const patterns = [
      /(?:process\.env|env)\.([A-Z][A-Z0-9_]*)/gu,
      /(?:intEnv|integerFromEnv)\(["']([A-Z][A-Z0-9_]*)["']/gu,
      /(?:required|optional|bounded|positive|tcpPort|integerEnv)\(env,\s*["']([A-Z][A-Z0-9_]*)["']/gu
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) runtimeVariables.add(match[1]);
    }
  }
}

const undocumentedRuntime = [...runtimeVariables]
  .filter((name) => !exampleVariables.has(name) && !derivedRuntimeVariables.has(name))
  .sort();
const worldOnly = [...worldExampleVariables].filter((name) => !exampleVariables.has(name)).sort();

const duplicateVariables = example.split(/\r?\n/u)
  .map((line) => /^([A-Z][A-Z0-9_]*)=/u.exec(line)?.[1])
  .filter(Boolean)
  .filter((name, index, values) => values.indexOf(name) !== index)
  .filter((name, index, values) => values.indexOf(name) === index)
  .sort();

if (missing.length || duplicateVariables.length || undocumentedRuntime.length || worldOnly.length) {
  if (missing.length) process.stderr.write(`Missing from ${examplePath}: ${missing.join(", ")}\n`);
  if (duplicateVariables.length) process.stderr.write(`Duplicate variables: ${duplicateVariables.join(", ")}\n`);
  if (undocumentedRuntime.length) process.stderr.write(`Undocumented runtime variables: ${undocumentedRuntime.join(", ")}\n`);
  if (worldOnly.length) process.stderr.write(`World template variables absent from canonical template: ${worldOnly.join(", ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Deployment environment template covers ${composeVariables.size - ignoredContainerVariables.size} Compose variables and audits ${runtimeVariables.size} runtime variables.\n`);
}
