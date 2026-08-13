import pg from "pg";
import { loadConfig } from "../../world-model-core/src/config.js";

const { Pool } = pg;

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

let sharedPool: pg.Pool | undefined;

export function databasePool(): pg.Pool {
  if (!sharedPool) {
    const config = loadConfig();
    sharedPool = new Pool({
      connectionString: config.databaseUrl,
      max: Number(process.env.DB_POOL_SIZE ?? 20),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: process.env.SERVICE_NAME ?? "gowm"
    });
    sharedPool.on("error", (error) => process.stderr.write(`postgres pool error: ${error.message}\n`));
  }
  return sharedPool;
}

export async function closeDatabasePool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = undefined;
  }
}

export async function withTransaction<T>(pool: pg.Pool, action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
