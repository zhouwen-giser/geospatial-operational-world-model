import pg from "pg";
import { validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { NetworkProviderOptions, NetworkSqlClient } from "./types.js";

export interface NetworkServerConfig { host: string; port: number; transportToken: string; provider: NetworkProviderOptions; close(): Promise<void>; }
export function loadNetworkProviderConfig(env: NodeJS.ProcessEnv = process.env): NetworkServerConfig {
  const connectionString = required(env, "NETWORK_PROVIDER_DATABASE_URL");
  const pool = new pg.Pool({ connectionString, application_name: "gowm-network-provider", max: bounded(env.NETWORK_PROVIDER_POOL_SIZE, 8, 128, "NETWORK_PROVIDER_POOL_SIZE"), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on("error", (error) => process.stderr.write(`network provider pool error: ${error.message}\n`));
  return {
    host: env.NETWORK_PROVIDER_HOST?.trim() || "0.0.0.0", port: bounded(env.NETWORK_PROVIDER_PORT, 8094, 65_535, "NETWORK_PROVIDER_PORT"),
    transportToken: validateProviderTransportToken(env.PROVIDER_TRANSPORT_SHARED_TOKEN),
    provider: {
      pool: { async connect(): Promise<NetworkSqlClient> { const client = await pool.connect(); return { async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) { const result = await client.query(text, values === undefined ? undefined : [...values]); return { rows: result.rows as T[], rowCount: result.rowCount }; }, release: () => client.release() }; }, end: () => pool.end() },
      statementTimeoutMs: bounded(env.NETWORK_PROVIDER_STATEMENT_TIMEOUT_MS, 10_000, 120_000, "NETWORK_PROVIDER_STATEMENT_TIMEOUT_MS"), lockTimeoutMs: bounded(env.NETWORK_PROVIDER_LOCK_TIMEOUT_MS, 1_000, 10_000, "NETWORK_PROVIDER_LOCK_TIMEOUT_MS"),
      maximumSegments: bounded(env.NETWORK_PROVIDER_MAXIMUM_SEGMENTS, 100_000, 100_000, "NETWORK_PROVIDER_MAXIMUM_SEGMENTS"), maximumMatrixPoints: bounded(env.NETWORK_PROVIDER_MAXIMUM_MATRIX_POINTS, 64, 500, "NETWORK_PROVIDER_MAXIMUM_MATRIX_POINTS")
    }, close: () => pool.end()
  };
}
function required(env: NodeJS.ProcessEnv, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function bounded(raw: string | undefined, fallback: number, maximum: number, name: string): number { const value = raw === undefined ? fallback : Number(raw); if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be between 1 and ${maximum}`); return value; }
