export interface SqlQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

export interface SqlExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<SqlQueryResult<Row>>;
}

export interface SqlConnection extends SqlExecutor {
  release(): void;
}

export interface SqlPool extends SqlExecutor {
  connect(): Promise<SqlConnection>;
}

export interface SqlExecutionBounds {
  /** Per-statement ceiling. Historical projection never accepts more than 30 seconds. */
  statementTimeoutMs?: number;
  /** Lock acquisition ceiling; also bounded by statementTimeoutMs. */
  lockTimeoutMs?: number;
}

export const MAX_HISTORICAL_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_HISTORICAL_LOCK_TIMEOUT_MS = 5_000;

function boundedMilliseconds(value: number | undefined, fallback: number, field: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_HISTORICAL_STATEMENT_TIMEOUT_MS) {
    throw new HistoricalProjectionInputError(
      `${field} must be an integer between 1 and ${MAX_HISTORICAL_STATEMENT_TIMEOUT_MS}`
    );
  }
  return candidate;
}

/** Applies transaction-local limits without relying on mutable role defaults. */
export async function configureLocalExecutionBounds(
  connection: SqlExecutor,
  bounds: SqlExecutionBounds = {}
): Promise<void> {
  const statementTimeoutMs = boundedMilliseconds(
    bounds.statementTimeoutMs,
    MAX_HISTORICAL_STATEMENT_TIMEOUT_MS,
    "statementTimeoutMs"
  );
  const lockTimeoutMs = boundedMilliseconds(
    bounds.lockTimeoutMs,
    Math.min(DEFAULT_HISTORICAL_LOCK_TIMEOUT_MS, statementTimeoutMs),
    "lockTimeoutMs"
  );
  if (lockTimeoutMs > statementTimeoutMs) {
    throw new HistoricalProjectionInputError("lockTimeoutMs cannot exceed statementTimeoutMs");
  }
  await connection.query(
    "SELECT set_config('statement_timeout',$1::text,true), set_config('lock_timeout',$2::text,true)",
    [`${statementTimeoutMs}ms`, `${lockTimeoutMs}ms`]
  );
}

export class ProjectionFenceLostError extends Error {
  public readonly code = "PROJECTION_FENCE_LOST";

  public constructor(message = "Projection lease or generation fence is no longer current") {
    super(message);
    this.name = "ProjectionFenceLostError";
  }
}

export class HistoricalProjectionInputError extends Error {
  public readonly code = "HISTORICAL_PROJECTION_INPUT_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "HistoricalProjectionInputError";
  }
}

/**
 * All append-only revisions, analysis inputs, mutable heads, and the queue CAS
 * must commit together. A false queue CAS is raised inside the transaction so
 * every preceding append is rolled back instead of leaking from a stale worker.
 */
export async function withProjectionTransaction<T>(
  pool: SqlPool,
  action: (connection: SqlConnection) => Promise<T>,
  bounds: SqlExecutionBounds = {}
): Promise<T> {
  const connection = await pool.connect();
  let open = false;
  try {
    await connection.query("BEGIN");
    open = true;
    await configureLocalExecutionBounds(connection,bounds);
    const result = await action(connection);
    await connection.query("COMMIT");
    open = false;
    return result;
  } catch (error) {
    if (open) await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HistoricalProjectionInputError(`${field} is missing`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requiredInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HistoricalProjectionInputError(`${field} is not an integer`);
  return parsed;
}

export function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new HistoricalProjectionInputError(`${field} is not a boolean`);
  return value;
}

export function isoTimestamp(value: unknown, field: string): string {
  const candidate = value instanceof Date ? value.toISOString() : value;
  if (typeof candidate !== "string") throw new HistoricalProjectionInputError(`${field} is missing`);
  const millis = Date.parse(candidate);
  if (!Number.isFinite(millis)) throw new HistoricalProjectionInputError(`${field} is not a timestamp`);
  return new Date(millis).toISOString();
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "historical projection failed";
}
