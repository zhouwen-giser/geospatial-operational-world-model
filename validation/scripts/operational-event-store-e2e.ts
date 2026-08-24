import { randomUUID } from "node:crypto";
import pg from "pg";
import { OperationalEventRepository } from "../../packages/runtime/src/operational-event-repository.js";
import { OperationalProjectionRepository } from "../../packages/runtime/src/operational-projection-repository.js";
import { OperationalCorrelationRepository } from "../../packages/runtime/src/operational-correlation-repository.js";
import { OperationalReadRepository } from "../../packages/runtime/src/operational-read-repository.js";
import { OperationalPredicateRepository } from "../../packages/runtime/src/operational-predicate-repository.js";
import { OperationalObservabilityRepository } from "../../packages/runtime/src/operational-observability-repository.js";
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
  const correlations = new OperationalCorrelationRepository(pool);
  const reads = new OperationalReadRepository(pool);
  const predicates = new OperationalPredicateRepository(pool);
  const observability = new OperationalObservabilityRepository(pool);
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
  const exactFinding = await correlations.resolve({
    dataScopeKey: scope,correlationHint: input.correlationClaims[0],actorReferenceKeys: []
  });
  const noMatchFinding = await correlations.resolve({
    dataScopeKey: scope,
    correlationHint: {
      claimId: `missing-${suffix}`,externalAuthority: "planner-missing",externalKind: "EXECUTION_INTENT",
      externalValue: `missing-${suffix}`,matchBasis: "PROPAGATED_CORRELATION_ID",confidence: 0.2,
      observedAt: eventTime,receivedAt: receivedTime,evidenceIds: []
    },
    actorReferenceKeys: []
  });
  const correlationReplay = await correlations.replay(scope,exactFinding.findingId);
  if (exactFinding.relation!=="REALIZES" || exactFinding.matchBasis!=="PROVIDER_DECLARED" ||
      exactFinding.operationalTaskReferenceKey?.id!==snapshot.referenceKey.id ||
      noMatchFinding.relation!=="NO_MATCH_FOUND" || "operationalTaskReferenceKey" in noMatchFinding ||
      correlationReplay!=="MATCH") {
    throw new Error("operational correlation E2E invariant failed");
  }
  const found = await reads.find(scope,{
    referenceKey: snapshot.referenceKey,actorReferenceKeys: input.actorReferenceKeys,
    from: new Date(Date.parse(eventTime)-1_000).toISOString(),limit: 10
  });
  const readTimeline = await reads.timeline(scope,snapshot.referenceKey,{ limit: 10 });
  const crossScope = await reads.find("default",{ referenceKey: snapshot.referenceKey,limit: 10 });
  if (found.result.tasks.length!==1 || found.result.tasks[0]?.operationalTaskId!==taskId ||
      readTimeline.result.events.length!==1 || readTimeline.result.events[0]?.eventId!==eventId ||
      crossScope.result.tasks.length!==0 || !/^sha256:[0-9a-f]{64}$/u.test(found.snapshot.scopeDigest)) {
    throw new Error("operational scoped read contract E2E invariant failed");
  }
  const assessmentFrom = new Date(Date.parse(eventTime)-1_000).toISOString();
  const assessmentTo = new Date(Date.now()+10_000).toISOString();
  await pool.query(
    `INSERT INTO operational_source_health_revision(
       data_scope_key,source_authority,health_status,valid_from,observed_at,evidence_id
     ) VALUES ($1,'provider-e2e','HEALTHY',clock_timestamp()-interval '1 hour',clock_timestamp(),$2)`,
    [scope,`health-${suffix}`]
  );
  await pool.query(
    `INSERT INTO operational_source_watermark_revision(
       data_scope_key,source_authority,closed_through_event_time,allowed_lateness,completeness_state,evidence_id
     ) VALUES ($1,'provider-e2e',$2::timestamptz+interval '1 hour',interval '5 seconds','COMPLETE',$3)`,
    [scope,assessmentTo,`watermark-${suffix}`]
  );
  await pool.query(
    `INSERT INTO operational_coverage_evidence(
       data_scope_key,subject_reference_key,source_authority,valid_time,coverage_sufficient,evidence_id,policy_version
     ) VALUES ($1,$2,'provider-e2e',tstzrange($3::timestamptz,$4::timestamptz+interval '1 minute','[)'),true,$5,'coverage-e2e-v1')`,
    [scope,snapshot.referenceKey.id,assessmentFrom,assessmentTo,`coverage-${suffix}`]
  );
  const assessmentInput = {
    dataScopeKey: scope,subjectReferenceKey: snapshot.referenceKey,
    timeRange: { from: assessmentFrom,to: assessmentTo },expectedSources: ["provider-e2e"]
  };
  const freshAssessment = await observability.assess({ ...assessmentInput,freshnessSlaSeconds: 300 });
  const staleAssessment = await observability.assess({ ...assessmentInput,freshnessSlaSeconds: 1 });
  await pool.query(
    `INSERT INTO operational_observation_gap(
       data_scope_key,subject_reference_key,source_authority,gap_time,evidence_id,reason
     ) VALUES ($1,$2,'provider-e2e',tstzrange($3::timestamptz,$4::timestamptz,'[)'),$5,'E2E explicit gap')`,
    [scope,snapshot.referenceKey.id,assessmentFrom,assessmentTo,`gap-${suffix}`]
  );
  const gapAssessment = await observability.assess({
    ...assessmentInput,timeRange: { from: assessmentFrom,to: new Date(Date.parse(assessmentTo)-1).toISOString() },
    freshnessSlaSeconds: 300
  });
  await pool.query(
    `INSERT INTO operational_source_health_revision(
       data_scope_key,source_authority,health_status,valid_from,observed_at,evidence_id
     ) VALUES ($1,'provider-e2e','UNHEALTHY',clock_timestamp(),clock_timestamp(),$2)`,
    [scope,`health-unhealthy-${suffix}`]
  );
  const unhealthyAssessment = await observability.assess({
    ...assessmentInput,timeRange: { from: new Date(Date.parse(assessmentFrom)+1).toISOString(),to: assessmentTo },
    freshnessSlaSeconds: 300
  });
  if (freshAssessment.assessment.status!=="FRESH" || !freshAssessment.assessment.coverageSufficient ||
      staleAssessment.assessment.status!=="STALE" || gapAssessment.assessment.status!=="OBSERVATION_GAP" ||
      gapAssessment.assessment.gapIntervals?.length!==1 ||
      unhealthyAssessment.assessment.status!=="SOURCE_UNHEALTHY" || unhealthyAssessment.assessment.coverageSufficient) {
    throw new Error("operational observability E2E invariant failed");
  }
  const factCountsBefore = await pool.query<{ identities: string;observations: string;world_events: string }>(
    `SELECT (SELECT count(*) FROM world_reference_identity)::text AS identities,
            (SELECT count(*) FROM world_observation)::text AS observations,
            (SELECT count(*) FROM world_event)::text AS world_events`
  );
  const occurred = await predicates.evaluate(scope,{
    predicateId: `predicate-occurred-${suffix}`,externalAuthority: "planner-e2e",
    subject: snapshot.referenceKey,operator: "EVENT_OCCURRED",
    object: { eventType: "EXECUTION_PROGRESS_OBSERVED" }
  });
  const occurredRetry = await predicates.evaluate(scope,occurred.predicate);
  const noData = await predicates.evaluate(scope,{
    predicateId: `predicate-no-data-${suffix}`,externalAuthority: "planner-e2e",
    subject: { externalReferenceId: `unknown-${suffix}` },operator: "HAS_OBSERVED"
  });
  const predicateReplay = await predicates.replay(scope,occurred.evaluation.evaluationId);
  const factCountsAfter = await pool.query<{ identities: string;observations: string;world_events: string }>(
    `SELECT (SELECT count(*) FROM world_reference_identity)::text AS identities,
            (SELECT count(*) FROM world_observation)::text AS observations,
            (SELECT count(*) FROM world_event)::text AS world_events`
  );
  if (occurred.evaluation.status!=="SUPPORTED" || occurred.evaluation.supportingEvidenceIds.length!==1 ||
      occurred.evaluation.observabilityAssessment?.status!=="SOURCE_UNHEALTHY" ||
      occurredRetry.evaluation.evaluationId!==occurred.evaluation.evaluationId ||
      noData.evaluation.status!=="NO_DATA" || predicateReplay!=="MATCH" ||
      JSON.stringify(factCountsBefore.rows[0])!==JSON.stringify(factCountsAfter.rows[0])) {
    throw new Error("external predicate evaluation E2E invariant failed");
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
    },
    correlation: {
      exactRelation: exactFinding.relation,exactBasis: exactFinding.matchBasis,
      noMatchRelation: noMatchFinding.relation,replay: correlationReplay
    },
    readContract: {
      taskCount: found.result.tasks.length,timelineEvents: readTimeline.result.events.length,
      crossScopeTaskCount: crossScope.result.tasks.length,scopeDigest: found.snapshot.scopeDigest
    },
    predicateEvaluation: {
      supportedStatus: occurred.evaluation.status,noDataStatus: noData.evaluation.status,
      observabilityStatus: occurred.evaluation.observabilityAssessment?.status,
      idempotentEvaluationId: occurred.evaluation.evaluationId,
      supportingEvidence: occurred.evaluation.supportingEvidenceIds.length,
      replay: predicateReplay,
      worldFactsUnchanged: true
    },
    observability: {
      freshStatus: freshAssessment.assessment.status,staleStatus: staleAssessment.assessment.status,
      gapStatus: gapAssessment.assessment.status,gapIntervals: gapAssessment.assessment.gapIntervals?.length,
      unhealthyStatus: unhealthyAssessment.assessment.status,
      coverageSufficient: freshAssessment.assessment.coverageSufficient
    }
  })}\n`);
} finally {
  await app.close();
  await closeDatabasePool();
  await pool.end();
}
