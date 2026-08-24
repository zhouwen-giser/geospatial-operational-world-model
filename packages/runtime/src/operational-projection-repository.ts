import type pg from "pg";
import {
  assertOperationalTaskSnapshot,
  type OperationalTaskSnapshot
} from "../../operational-model/src/events.js";

export class OperationalProjectionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async projectPending(batchSize = 100): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      "SELECT project_pending_operational_tasks($1)::integer AS count",[batchSize]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async get(dataScopeKey: string,operationalTaskId: string): Promise<OperationalTaskSnapshot | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM operational_task_snapshot
       WHERE data_scope_key=$1 AND operational_task_id=$2`,
      [dataScopeKey,operationalTaskId]
    );
    const row = result.rows[0] as Record<string,unknown> | undefined;
    return row ? mapOperationalTaskSnapshot(row) : undefined;
  }

  async rebuild(dataScopeKey: string,policyVersion = "operational-projection-v1"): Promise<{
    rebuilt: number;
    currentHash: string;
    replayHash: string;
  }> {
    const rebuilt = await this.pool.query<{ count: number }>(
      "SELECT rebuild_operational_task_snapshots($1,$2)::integer AS count",[dataScopeKey,policyVersion]
    );
    const hashes = await this.pool.query<{ current_hash: string; replay_hash: string }>(
      `SELECT operational_snapshot_current_hash($1) AS current_hash,
              operational_snapshot_replay_hash($1,$2) AS replay_hash`,
      [dataScopeKey,policyVersion]
    );
    const row = hashes.rows[0];
    if (!row || row.current_hash!==row.replay_hash) throw new Error("operational snapshot replay hash mismatch");
    return { rebuilt: Number(rebuilt.rows[0]?.count ?? 0),currentHash: row.current_hash,replayHash: row.replay_hash };
  }
}

function mapOperationalTaskSnapshot(row: Record<string,unknown>): OperationalTaskSnapshot {
  const snapshot: OperationalTaskSnapshot = {
    referenceKey: {
      namespace: "gowm",kind: "OPERATIONAL_TASK",id: String(row.reference_key),version: "1"
    },
    operationalTaskId: String(row.operational_task_id),
    taskType: String(row.task_type),
    controlState: String(row.control_state) as OperationalTaskSnapshot["controlState"],
    activityState: String(row.activity_state) as OperationalTaskSnapshot["activityState"],
    outcomeVerification: String(row.outcome_verification) as OperationalTaskSnapshot["outcomeVerification"],
    observability: String(row.observability) as OperationalTaskSnapshot["observability"],
    actorReferenceKeys: json(row.actor_reference_keys),
    targetReferenceKeys: json(row.target_reference_keys),
    ...(row.first_observed_at ? { firstObservedAt: iso(row.first_observed_at) } : {}),
    ...(row.last_observed_at ? { lastObservedAt: iso(row.last_observed_at) } : {}),
    ...(row.last_received_at ? { lastReceivedAt: iso(row.last_received_at) } : {}),
    evidenceIds: json(row.evidence_ids),
    worldVersion: Number(row.world_version),
    projectionPolicyVersion: String(row.projection_policy_version)
  };
  assertOperationalTaskSnapshot(snapshot);
  return snapshot;
}

function json<T>(value: unknown): T {
  return (typeof value==="string" ? JSON.parse(value) : value) as T;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
