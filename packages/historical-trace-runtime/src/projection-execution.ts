import { AsyncLocalStorage } from "node:async_hooks";
import type { SqlPool, SqlExecutor } from "./database.js";

const execution = new AsyncLocalStorage<() => void>();

export function withProjectionExecution<T>(check: () => void, action: () => Promise<T>): Promise<T> {
  return execution.run(check, action);
}

/** Every subsequent SQL is stopped after cancellation or lost ownership.
 * In-flight SQL keeps the existing 30-second bound; rollback always remains possible. */
export function guardedProjectionPool(pool: SqlPool): SqlPool {
  function executor(target: SqlExecutor): SqlExecutor {
    return { async query(text, values) {
      const rollback = /^\s*ROLLBACK\b/i.test(text);
      if (!rollback) execution.getStore()?.();
      const result = await target.query(text, values);
      // Once COMMIT has succeeded, a concurrent renewal observing COMPLETED
      // must not turn that successful atomic commit into a reported failure.
      if (!rollback && !/^\s*COMMIT\b/i.test(text)) execution.getStore()?.();
      return result as never;
    }};
  }
  return { ...executor(pool), async connect() {
    const client = await pool.connect();
    return { ...executor(client), release: () => client.release() };
  }};
}
