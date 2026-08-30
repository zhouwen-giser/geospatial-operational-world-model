import type pg from "pg";
import {
  HistoricalProjectionCoordinator,
  PostgresHistoricalTrajectoryMaterializer,
  PostgresHistoricalTrajectoryProjectionRepository,
  PostgresTaskIntervalProjectionRepository,
  PostgresTrackletProjectionRepository,
  type SqlPool,
  type SqlQueryResult
} from "../../../packages/historical-trace-runtime/src/index.js";
import type { HistoricalProjectionStages } from "./worker.js";

export function createPostgresHistoricalProjectionStages(pool: pg.Pool): HistoricalProjectionStages {
  const historicalPool = postgresSqlPool(pool);
  return new HistoricalProjectionCoordinator({
    intervals: new PostgresTaskIntervalProjectionRepository(historicalPool),
    tracklets: new PostgresTrackletProjectionRepository(historicalPool),
    trajectories: new PostgresHistoricalTrajectoryProjectionRepository(historicalPool),
    materializer: new PostgresHistoricalTrajectoryMaterializer(historicalPool)
  });
}

function postgresSqlPool(pool: pg.Pool): SqlPool {
  return {
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[]
    ) => query<Row>(pool, text, values),
    async connect() {
      const client = await pool.connect();
      return {
        query: <Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values?: readonly unknown[]
        ) => query<Row>(client, text, values),
        release: () => client.release()
      };
    }
  };
}

async function query<Row extends Record<string, unknown>>(
  executor: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  text: string,
  values?: readonly unknown[]
): Promise<SqlQueryResult<Row>> {
  const result = values === undefined
    ? await executor.query(text)
    : await executor.query(text, [...values]);
  return {
    rows: result.rows as Row[],
    ...(result.rowCount === null ? {} : { rowCount: result.rowCount })
  };
}
