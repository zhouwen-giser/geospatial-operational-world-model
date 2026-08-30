import pg from "pg";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";

export interface HistoricalTraceServerConfig {
  host: string;
  port: number;
  transportToken: string;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function loadHistoricalTraceConfig(
  env: NodeJS.ProcessEnv = process.env
): HistoricalTraceServerConfig {
  const connectionString = required(env, "HISTORICAL_TRACE_DATABASE_URL");
  const transportToken = validateProviderTransportToken(env.PROVIDER_TRANSPORT_SHARED_TOKEN);
  const host = env.HISTORICAL_TRACE_HOST?.trim() || "0.0.0.0";
  const port = bounded(env.HISTORICAL_TRACE_PORT, 8_100, 65_535, "HISTORICAL_TRACE_PORT");
  const maximumConnections = bounded(
    env.HISTORICAL_TRACE_POOL_SIZE,
    8,
    64,
    "HISTORICAL_TRACE_POOL_SIZE"
  );
  const pool = new pg.Pool({
    connectionString,
    application_name: "gowm-historical-trace-provider",
    max: maximumConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  pool.on("error", () => process.stderr.write("historical trace pool error\n"));
  return {
    host,
    port,
    transportToken,
    pool,
    close: () => pool.end()
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bounded(
  raw: string | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}
