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

export function createPostgresHistoricalProjectionStages(pool: pg.Pool, execution: {leasePool?: pg.Pool; requestPool?: pg.Pool; trackletPool?:pg.Pool; finalizationPool?:pg.Pool; signal?: AbortSignal} = {}): HistoricalProjectionStages {
  const historicalPool = postgresSqlPool(pool);
  const requestPool = execution.requestPool ? postgresSqlPool(execution.requestPool) : historicalPool;
  const leases={...(execution.leasePool?{leasePool:postgresSqlPool(execution.leasePool)}:{}),...(execution.signal?{signal:execution.signal}:{})};
  const tracklets=new PostgresTrackletProjectionRepository(execution.trackletPool?postgresSqlPool(execution.trackletPool):historicalPool,leases);
  const finalizations=new PostgresTrackletProjectionRepository(execution.finalizationPool?postgresSqlPool(execution.finalizationPool):historicalPool,leases);
  return new HistoricalProjectionCoordinator({
    intervals: new PostgresTaskIntervalProjectionRepository(historicalPool),
    tracklets: {
      claimTracklets:tracklets.claimTracklets.bind(tracklets),rebuildAndComplete:tracklets.rebuildAndComplete.bind(tracklets),failTracklet:tracklets.failTracklet.bind(tracklets),
      claimFinalizations:finalizations.claimFinalizations.bind(finalizations),loadFinalization:finalizations.loadFinalization.bind(finalizations),
      finalizeAndComplete:finalizations.finalizeAndComplete.bind(finalizations),failFinalization:finalizations.failFinalization.bind(finalizations),
      withLease:(claim,kind,action)=>(kind==="projection"?tracklets:finalizations).withLease(claim,kind,action)
    },
    trajectories: new PostgresHistoricalTrajectoryProjectionRepository(requestPool, {}, {
      ...(execution.leasePool ? {leasePool:postgresSqlPool(execution.leasePool)} : {}),
      ...(execution.signal ? {signal:execution.signal} : {})
    }),
    materializer: new PostgresHistoricalTrajectoryMaterializer(requestPool)
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
