import type {
  ExistingTaskIntervalRevision,
  ReconstructedTaskExecutionInterval,
  TaskIntervalEvent,
  TaskIntervalMethodProfile,
  TaskIntervalReconstructionResult,
  TaskIntervalRevisionPlan
} from "../../historical-trace-model/src/index.js";
import { planTaskIntervalRevisions } from "../../historical-trace-core/src/index.js";
import {
  HistoricalProjectionInputError,
  ProjectionFenceLostError,
  errorMessage,
  isoTimestamp,
  optionalString,
  requiredInteger,
  requiredString,
  type SqlExecutor,
  type SqlPool,
  withProjectionTransaction
} from "./database.js";

export interface TaskIntervalProjectionClaim {
  queueId: string;
  dataScopeKey: string;
  operationalTaskId: string;
  desiredEventSetHash: `sha256:${string}`;
  generation: number;
  workerId: string;
  projectionAsOf: string;
  leaseUntil: string;
}

export interface TaskIntervalProjectionInput {
  claim: TaskIntervalProjectionClaim;
  events: TaskIntervalEvent[];
  profile: TaskIntervalMethodProfile;
}

export interface TaskIntervalCommitResult {
  appendedRevisionIds: string[];
  reusedRevisionIds: string[];
  supersededBeforeProjection: boolean;
}

export interface TaskIntervalProjectionRepository {
  claim(workerId: string, batchSize: number, leaseSeconds: number): Promise<TaskIntervalProjectionClaim[]>;
  load(claim: TaskIntervalProjectionClaim): Promise<TaskIntervalProjectionInput>;
  commit(
    input: TaskIntervalProjectionInput,
    reconstruction: TaskIntervalReconstructionResult
  ): Promise<TaskIntervalCommitResult>;
  fail(claim: TaskIntervalProjectionClaim, error: unknown, retryAt: string): Promise<boolean>;
}

interface QueueRow extends Record<string, unknown> {
  queue_id: unknown;
  data_scope_key: unknown;
  operational_task_id: unknown;
  desired_event_set_hash: unknown;
  generation: unknown;
  locked_at: unknown;
  lease_until: unknown;
}

interface EventRow extends Record<string, unknown> {
  event_id: unknown;
  event_type: unknown;
  event_time: unknown;
  received_time: unknown;
  source_authority: unknown;
  source_event_key: unknown;
  source_revision_no: unknown;
  content_hash: unknown;
  confidence: unknown;
}

interface ProfileRow extends Record<string, unknown> {
  profile_key: unknown;
  profile_version: unknown;
  content_hash: unknown;
  definition: unknown;
}

interface RevisionRow extends Record<string, unknown> {
  interval_revision_id: unknown;
  execution_no: unknown;
  revision_no: unknown;
  content_hash: unknown;
}

function mapClaim(row: QueueRow, workerId: string): TaskIntervalProjectionClaim {
  const digest = requiredString(row.desired_event_set_hash, "desired_event_set_hash");
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new HistoricalProjectionInputError("desired_event_set_hash is not SHA-256");
  }
  return {
    queueId: requiredString(row.queue_id, "queue_id"),
    dataScopeKey: requiredString(row.data_scope_key, "data_scope_key"),
    operationalTaskId: requiredString(row.operational_task_id, "operational_task_id"),
    desiredEventSetHash: digest as `sha256:${string}`,
    generation: requiredInteger(row.generation, "generation"),
    workerId,
    projectionAsOf: isoTimestamp(row.locked_at, "locked_at"),
    leaseUntil: isoTimestamp(row.lease_until, "lease_until")
  };
}

function mapEvent(row: EventRow): TaskIntervalEvent {
  const event: TaskIntervalEvent = {
    eventId: requiredString(row.event_id, "event_id"),
    eventType: requiredString(row.event_type, "event_type"),
    eventTime: isoTimestamp(row.event_time, "event_time"),
    receivedTime: isoTimestamp(row.received_time, "received_time"),
    sourceAuthority: requiredString(row.source_authority, "source_authority"),
    sourceEventKey: requiredString(row.source_event_key, "source_event_key"),
    sourceRevisionNo: requiredInteger(row.source_revision_no, "source_revision_no"),
    eventContentHash: requiredString(row.content_hash, "content_hash") as `sha256:${string}`
  };
  if (row.confidence !== null && row.confidence !== undefined) {
    const confidence = Number(row.confidence);
    if (!Number.isFinite(confidence)) throw new HistoricalProjectionInputError("confidence is invalid");
    event.confidence = confidence;
  }
  return event;
}

function mapProfile(row: ProfileRow): TaskIntervalMethodProfile {
  const definition = row.definition;
  if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
    throw new HistoricalProjectionInputError("task interval profile definition is invalid");
  }
  const value = definition as Record<string, unknown>;
  return {
    profileKey: requiredString(row.profile_key, "profile_key"),
    profileVersion: Number.parseFloat(requiredString(row.profile_version, "profile_version")),
    profileHash: requiredString(row.content_hash, "profile content_hash") as `sha256:${string}`,
    legacyResumeFromStarted: value.legacyResumeFromStarted === true,
    allowControlCompletionAsTerminal: value.allowControlCompletionAsTerminal === true
  };
}

function mapExistingRevision(row: RevisionRow): ExistingTaskIntervalRevision {
  return {
    intervalRevisionId: requiredString(row.interval_revision_id, "interval_revision_id"),
    executionNo: requiredInteger(row.execution_no, "execution_no"),
    revisionNo: requiredInteger(row.revision_no, "revision_no"),
    contentHash: requiredString(row.content_hash, "content_hash") as `sha256:${string}`
  };
}

function timestampRange(start: string | undefined, end: string | undefined): string {
  if (start === undefined) return end === undefined ? "(,)" : `(,${end})`;
  return end === undefined ? `[${start},)` : `[${start},${end})`;
}

function databaseDerivation(interval: ReconstructedTaskExecutionInterval): "OBSERVED_ONLY" | "MIXED" | "CONFLICTED" {
  if (interval.lifecycleState === "CONFLICTED" || interval.derivationKind === "INFERRED") return "CONFLICTED";
  return interval.derivationKind === "OBSERVED" ? "OBSERVED_ONLY" : "MIXED";
}

function inputRole(
  event: TaskIntervalEvent,
  interval: ReconstructedTaskExecutionInterval
): "START_BOUNDARY" | "TERMINAL_BOUNDARY" | "PHASE_BOUNDARY" | "PROGRESS" | "CONFLICT" | "ORPHAN_EVIDENCE" {
  if (!interval.inputEvents.some((candidate) => candidate.eventId === event.eventId)) return "ORPHAN_EVIDENCE";
  if (interval.reasonCodes.includes("SAME_TIME_CONFLICT") || interval.lifecycleState === "CONFLICTED") return "CONFLICT";
  if (event.eventId === interval.startEventId) return "START_BOUNDARY";
  if (event.eventId === interval.terminalEventId) return "TERMINAL_BOUNDARY";
  if (event.eventType === "EXECUTION_PAUSED_OBSERVED" || event.eventType === "EXECUTION_RESUMED_OBSERVED") {
    return "PHASE_BOUNDARY";
  }
  return event.eventType === "EXECUTION_PROGRESS_OBSERVED" ? "PROGRESS" : "ORPHAN_EVIDENCE";
}

async function currentEventSetHash(
  connection: SqlExecutor,
  claim: TaskIntervalProjectionClaim
): Promise<string> {
  const result = await connection.query<{ event_set_hash: unknown }>(`
    SELECT public.grounding_sha256(COALESCE(jsonb_agg(
      jsonb_build_array(
        event.event_time, event.received_time, event.source_authority,
        event.source_event_key, event.source_revision_no, event.event_id,
        event.content_hash
      ) ORDER BY
        event.event_time, event.received_time, event.source_authority,
        event.source_event_key, event.source_revision_no, event.event_id
    )::text, '[]')) AS event_set_hash
    FROM public.operational_task_event event
    WHERE event.data_scope_key = $1
      AND event.operational_task_id = $2
  `, [claim.dataScopeKey, claim.operationalTaskId]);
  return requiredString(result.rows[0]?.event_set_hash, "event_set_hash");
}

async function completeClaim(connection: SqlExecutor, claim: TaskIntervalProjectionClaim): Promise<void> {
  const result = await connection.query<{ completed: unknown }>(`
    SELECT gowm_history.complete_task_interval_projection($1::uuid, $2::text, $3::bigint) AS completed
  `, [claim.queueId, claim.workerId, claim.generation]);
  if (result.rows[0]?.completed !== true) throw new ProjectionFenceLostError();
}

async function currentRevisions(
  connection: SqlExecutor,
  claim: TaskIntervalProjectionClaim
): Promise<ExistingTaskIntervalRevision[]> {
  const result = await connection.query<RevisionRow>(`
    SELECT revision.interval_revision_id, interval.execution_no,
           revision.revision_no, revision.content_hash
    FROM gowm_history.task_execution_interval interval
    JOIN gowm_history.task_execution_interval_head head USING (interval_id)
    JOIN gowm_history.task_execution_interval_revision revision
      ON revision.interval_revision_id = head.current_revision_id
    WHERE interval.data_scope_key = $1
      AND interval.operational_task_id = $2
    ORDER BY interval.execution_no
  `, [claim.dataScopeKey, claim.operationalTaskId]);
  return result.rows.map(mapExistingRevision);
}

async function appendRevision(
  connection: SqlExecutor,
  input: TaskIntervalProjectionInput,
  plan: Extract<TaskIntervalRevisionPlan, { action: "APPEND" }>
): Promise<string> {
  const interval = plan.interval;
  const phases = interval.phases.map((phase) => ({
    phaseNo: phase.phaseNo,
    phaseKind: phase.phaseKind,
    phaseRange: timestampRange(phase.start, phase.end),
    startEventId: phase.startEventId ?? "",
    endEventId: phase.endEventId ?? "",
    confidence: phase.confidence ?? "",
    reasonCodes: phase.reasonCodes
  }));
  const inputs = input.events.map((event, index) => ({
    eventNo: index + 1,
    eventId: event.eventId,
    eventContentHash: event.eventContentHash,
    inputRole: inputRole(event, interval)
  }));
  const profile = input.profile;
  const result = await connection.query<{ revision_id: unknown }>(`
    SELECT gowm_history.register_task_execution_interval_revision(
      $1::text, $2::text, $3::integer, $4::tstzrange, $5::text,
      $6::text, $7::text, $8::text, $9::text, $10::text,
      $11::text, $12::text, $13::text, $14::double precision,
      $15::text[], $16::text, $17::uuid, $18::jsonb, $19::jsonb
    ) AS revision_id
  `, [
    input.claim.dataScopeKey,
    input.claim.operationalTaskId,
    interval.executionNo,
    timestampRange(interval.start, interval.end),
    interval.lifecycleState,
    databaseDerivation(interval),
    interval.stabilityState,
    interval.startEventId ?? null,
    interval.terminalEventId ?? null,
    input.claim.desiredEventSetHash,
    profile.profileKey,
    String(profile.profileVersion.toFixed(1)),
    profile.profileHash,
    interval.confidence ?? null,
    interval.reasonCodes,
    interval.contentHash,
    plan.supersedesRevisionId ?? null,
    JSON.stringify(phases),
    JSON.stringify(inputs)
  ]);
  return requiredString(result.rows[0]?.revision_id, "revision_id");
}

export class PostgresTaskIntervalProjectionRepository implements TaskIntervalProjectionRepository {
  public constructor(private readonly pool: SqlPool) {}

  public async claim(workerId: string, batchSize: number, leaseSeconds: number): Promise<TaskIntervalProjectionClaim[]> {
    const result = await this.pool.query<QueueRow>(`
      SELECT *
      FROM gowm_history.claim_task_interval_projection(
        $1::text, $2::integer, make_interval(secs => $3::double precision)
      )
    `, [workerId, batchSize, leaseSeconds]);
    return result.rows.map((row) => mapClaim(row, workerId));
  }

  public async load(claim: TaskIntervalProjectionClaim): Promise<TaskIntervalProjectionInput> {
    const [eventResult, profileResult] = await Promise.all([
      this.pool.query<EventRow>(`
        SELECT event_id, event_type, event_time, received_time, source_authority,
               source_event_key, source_revision_no, content_hash, confidence
        FROM public.operational_task_event
        WHERE data_scope_key = $1
          AND operational_task_id = $2
          AND created_at <= $3::timestamptz
        ORDER BY event_time, received_time, source_authority, source_event_key,
                 source_revision_no, event_id
      `, [claim.dataScopeKey, claim.operationalTaskId, claim.projectionAsOf]),
      this.pool.query<ProfileRow>(`
        SELECT profile_key, profile_version, content_hash, definition
        FROM gowm_history.method_profile
        WHERE profile_key = 'task-interval-observed-v1'
          AND profile_kind = 'TASK_INTERVAL'
        ORDER BY created_at DESC
        LIMIT 1
      `)
    ]);
    const profileRow = profileResult.rows[0];
    if (profileRow === undefined) throw new HistoricalProjectionInputError("task interval profile is unavailable");
    return { claim, events: eventResult.rows.map(mapEvent), profile: mapProfile(profileRow) };
  }

  public async commit(
    input: TaskIntervalProjectionInput,
    reconstruction: TaskIntervalReconstructionResult
  ): Promise<TaskIntervalCommitResult> {
    return withProjectionTransaction(this.pool, async (connection) => {
      if (await currentEventSetHash(connection, input.claim) !== input.claim.desiredEventSetHash) {
        await completeClaim(connection, input.claim);
        return { appendedRevisionIds: [], reusedRevisionIds: [], supersededBeforeProjection: true };
      }

      const plans = planTaskIntervalRevisions(reconstruction.executions, await currentRevisions(connection, input.claim));
      const appendedRevisionIds: string[] = [];
      const reusedRevisionIds: string[] = [];
      for (const plan of plans) {
        if (plan.action === "REUSE") reusedRevisionIds.push(plan.existingRevisionId);
        else appendedRevisionIds.push(await appendRevision(connection, input, plan));
      }
      await completeClaim(connection, input.claim);
      return { appendedRevisionIds, reusedRevisionIds, supersededBeforeProjection: false };
    });
  }

  public async fail(claim: TaskIntervalProjectionClaim, error: unknown, retryAt: string): Promise<boolean> {
    const result = await this.pool.query<{ failed: unknown }>(`
      SELECT gowm_history.fail_task_interval_projection(
        $1::uuid, $2::text, $3::bigint, $4::text, $5::timestamptz
      ) AS failed
    `, [claim.queueId, claim.workerId, claim.generation, errorMessage(error), retryAt]);
    return result.rows[0]?.failed === true;
  }
}
