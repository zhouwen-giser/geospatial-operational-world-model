import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { Config } from '../config.js';
import { AppError, mapDatabaseError } from '../domain/errors.js';

const { Pool } = pg;

export class Transaction {
  private readonly executedStatements: Array<{ text: string }> = [];

  public constructor(
    private readonly client: PoolClient,
    private readonly expiresAt: number,
    public readonly databaseSnapshotId: string,
  ) {}

  public async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const remaining = this.expiresAt - Date.now();
    if (remaining <= 0) {
      throw new AppError('DEADLINE_EXCEEDED', 504, 'Deadline exceeded', 'The analysis deadline elapsed before the next database operation.');
    }
    await this.client.query("SELECT set_config('statement_timeout', $1, true)", [`${remaining}ms`]);
    this.executedStatements.push({ text });
    try {
      return await this.client.query<T>(text, [...values]);
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  public get executedStatementCount(): number {
    return this.executedStatements.length;
  }

  public executedStatementsSince(offset: number): ReadonlyArray<{ text: string }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.executedStatements.length) {
      throw new RangeError('statement capture offset is outside the executed statement sequence');
    }
    return this.executedStatements.slice(offset);
  }

  public async runtimeMetadata(): Promise<{ mobilityDbVersion: string; postgisVersion: string; schemaContractVersion: string; analysisSrid: number }> {
    const result = await this.query<{
      mobilitydb_version: string; postgis_version: string; schema_contract_version: string; analysis_srid: number;
    }>(`
      SELECT m.extversion AS mobilitydb_version,p.extversion AS postgis_version,
             c.schema_contract_version,c.analysis_srid
      FROM gowm_stas_v1.deployment_config c
      CROSS JOIN pg_extension m CROSS JOIN pg_extension p
      WHERE c.singleton AND m.extname='mobilitydb' AND p.extname='postgis'
    `);
    const row = result.rows[0];
    if (row === undefined) throw new AppError('DATABASE_UNAVAILABLE', 503, 'Database metadata unavailable', 'The pinned extension/schema deployment metadata is unavailable.');
    return { mobilityDbVersion: row.mobilitydb_version, postgisVersion: row.postgis_version, schemaContractVersion: row.schema_contract_version, analysisSrid: row.analysis_srid };
  }
}

export class Database {
  private readonly pool: pg.Pool;

  public constructor(config: Config) {
    this.pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
      application_name: `mobilitydb-stas/${config.SERVICE_VERSION}`,
    });
  }

  public async withTransaction<T>(
    deadlineMs: number,
    mode: 'REPEATABLE_READ' | 'SERIALIZABLE',
    operation: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    const expiresAt = Date.now() + deadlineMs;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      if (Date.now() >= expiresAt) {
        throw new AppError('DEADLINE_EXCEEDED', 504, 'Deadline exceeded', 'The deadline elapsed while waiting for a database connection.');
      }
      await client.query(mode === 'SERIALIZABLE'
        ? 'BEGIN ISOLATION LEVEL SERIALIZABLE'
        : 'BEGIN ISOLATION LEVEL REPEATABLE READ');
      const snapshotResult = await client.query<{ snapshot_id: string }>('SELECT txid_current_snapshot()::text AS snapshot_id');
      const snapshotId = snapshotResult.rows[0]?.snapshot_id;
      if (snapshotId === undefined) {
        throw new AppError('SNAPSHOT_NOT_AVAILABLE', 503, 'Snapshot unavailable', 'PostgreSQL did not return a transaction snapshot.');
      }
      const transaction = new Transaction(client, expiresAt, snapshotId);
      const result = await operation(transaction);
      if (Date.now() > expiresAt) {
        throw new AppError('DEADLINE_EXCEEDED', 504, 'Deadline exceeded', 'The operation exceeded its declared deadline.');
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client !== undefined) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original domain/database error.
        }
      }
      throw mapDatabaseError(error);
    } finally {
      client?.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
