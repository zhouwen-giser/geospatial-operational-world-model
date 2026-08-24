import { randomUUID } from "node:crypto";
import pg from "pg";
import { OperationalEventRepository } from "../../packages/runtime/src/operational-event-repository.js";
import { OperationalProjectionRepository } from "../../packages/runtime/src/operational-projection-repository.js";
import { closeDatabasePool } from "../../packages/runtime/src/db.js";
import { buildObservationApp } from "../../services/observation-ingest/src/app.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const suffix = randomUUID().replaceAll("-","").slice(0,16);
const scope = `operational-e2e-${suffix}`;
const eventId = `operational-event-${suffix}`;
const taskId = `ot_${suffix}`;
const eventTime = new Date(Date.now()-60_000).toISOString();
const receivedTime = new Date().toISOString();
const retryReceivedTime = new Date(Date.now()+1_000).toISOString();
const pool = new pg.Pool({ connectionString: databaseUrl,max: 2 });
const app = buildObservationApp();

try {
  await pool.query(
    "INSERT INTO data_scope(scope_key,operational_domain,description) VALUES ($1,'TEST','Operational event E2E')",
    [scope]
  );
  const repository = new OperationalEventRepository(pool);
  const projections = new OperationalProjectionRepository(pool);
  const input = {
    dataScopeKey: scope,
    sourceAuthority: "provider-e2e",
    sourceEventKey: `source-${suffix}`,
    sourceRevisionNo: 1,
    eventId,
    operationalTaskId: taskId,
    eventType: "EXECUTION_PROGRESS_OBSERVED",
    eventTime,
    actorReferenceKeys: [{
      namespace: "gowm",kind: "WORLD_OBJECT",id: "wrf_11111111111111111111111111111111",version: "1"
    }],
    targetReferenceKeys: [{
      namespace: "gowm",kind: "WORLD_OBJECT",id: "wrf_22222222222222222222222222222222",version: "1"
    }],
    payload: { progress: 0.5 },
    confidence: 0.9,
    provenance: [{
      evidenceId: `evidence-${suffix}`,authority: "provider-e2e",evidenceType: "PROVIDER_EVENT",observedAt: eventTime
    }],
    correlationClaims: [{
      claimId: `claim-${suffix}`,externalAuthority: "provider-e2e",externalKind: "PROVIDER_ACTION",
      externalValue: `provider-action-${suffix}`,relationHint: "RELATED_TO",matchBasis: "PROVIDER_DECLARED",
      confidence: 1,observedAt: eventTime,receivedAt: receivedTime,evidenceIds: [`evidence-${suffix}`]
    }]
  };
  const accepted = await repository.insert(input,receivedTime);
  const duplicate = await repository.insert(input,retryReceivedTime);
  const timeline = await repository.timeline(scope,taskId);
  const evidence = await pool.query<{ outbox_count: string; claim_count: string; leaked_count: string }>(
    `SELECT
       (SELECT count(*) FROM operational_event_outbox WHERE data_scope_key=$1 AND event_id=$2)::text AS outbox_count,
       (SELECT count(*) FROM external_correlation_claim WHERE data_scope_key=$1 AND source_kind='OPERATIONAL_EVENT' AND source_id=$2)::text AS claim_count,
       (SELECT count(*) FROM operational_task_event WHERE data_scope_key='default' AND event_id=$2)::text AS leaked_count`,
    [scope,eventId]
  );
  const counts = evidence.rows[0];
  if (accepted.status!=="accepted" || duplicate.status!=="duplicate" ||
      accepted.event.worldVersion!==duplicate.event.worldVersion || timeline.length!==1 ||
      timeline[0]?.receivedTime!==receivedTime || counts?.outbox_count!=="1" ||
      counts.claim_count!=="1" || counts.leaked_count!=="0") {
    throw new Error("operational event repository E2E invariant failed");
  }

  const httpScope = `${scope}-http`;
  const httpEventId = `${eventId}-http`;
  await pool.query(
    "INSERT INTO data_scope(scope_key,operational_domain,description) VALUES ($1,'TEST','Operational event HTTP E2E')",
    [httpScope]
  );
  const httpInput = {
    ...input,
    dataScopeKey: httpScope,
    sourceEventKey: `${input.sourceEventKey}-http`,
    eventId: httpEventId,
    operationalTaskId: `${taskId}-http`,
    correlationClaims: []
  };
  const denied = await app.inject({ method: "POST",url: "/operational-events",payload: httpInput });
  const httpAccepted = await app.inject({
    method: "POST",url: "/operational-events",headers: { "x-data-scope-key": httpScope },payload: httpInput
  });
  const httpDuplicate = await app.inject({
    method: "POST",url: "/operational-events",headers: { "x-data-scope-key": httpScope },payload: httpInput
  });
  const acceptedBody = httpAccepted.json<Record<string,unknown>>();
  const duplicateBody = httpDuplicate.json<Record<string,unknown>>();
  if (denied.statusCode!==403 || httpAccepted.statusCode!==202 || httpDuplicate.statusCode!==200 ||
      acceptedBody.status!=="accepted" || duplicateBody.status!=="duplicate" ||
      acceptedBody.eventTime!==eventTime || typeof acceptedBody.receivedTime!=="string") {
    throw new Error("operational event HTTP boundary E2E invariant failed");
  }
  const operationalProjected = await projections.projectPending(100);
  const snapshot = await projections.get(scope,taskId);
  const replay = await projections.rebuild(scope);
  if (operationalProjected<2 || !snapshot || snapshot.controlState!=="NO_CONTROL_EVENT" ||
      snapshot.activityState!=="ACTIVE_OBSERVED" || snapshot.outcomeVerification!=="UNVERIFIED" ||
      snapshot.observability!=="FRESH" || replay.currentHash!==replay.replayHash) {
    throw new Error("operational four-dimensional projection E2E invariant failed");
  }
  process.stdout.write(`${JSON.stringify({
    result: "OPERATIONAL_EVENT_STORE_E2E_PASS",
    scope,eventId,worldVersion: accepted.event.worldVersion,
    duplicateStatus: duplicate.status,timelineEvents: timeline.length,
    outboxRows: Number(counts.outbox_count),claimRows: Number(counts.claim_count),scopeLeakRows: Number(counts.leaked_count),
    http: { deniedStatus: denied.statusCode,acceptedStatus: httpAccepted.statusCode,duplicateStatus: httpDuplicate.statusCode },
    projection: {
      projected: operationalProjected,controlState: snapshot.controlState,activityState: snapshot.activityState,
      outcomeVerification: snapshot.outcomeVerification,observability: snapshot.observability,
      worldVersion: snapshot.worldVersion,replayHash: replay.replayHash
    }
  })}\n`);
} finally {
  await app.close();
  await closeDatabasePool();
  await pool.end();
}
