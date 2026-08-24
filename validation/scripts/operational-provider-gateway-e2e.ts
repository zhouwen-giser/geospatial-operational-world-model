import { randomUUID } from "node:crypto";
import pg from "pg";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { OperationalEventRepository } from "../../packages/runtime/src/operational-event-repository.js";
import { OperationalProjectionRepository } from "../../packages/runtime/src/operational-projection-repository.js";
import {
  buildGatewayApp,CapabilityRegistry,DirectExecutionService,HttpProviderClient,
  MemoryAuditSink,MemoryGatewayIdempotencyStore,MemoryGatewayRecordStore,ProviderCircuitBreaker
} from "../../services/gateway/world-capability-gateway/src/index.js";
import { buildOperationalRealityApp } from "../../services/providers/operational-reality-provider/src/app.js";
import { createOperationalRealityProvider } from "../../services/providers/operational-reality-provider/src/provider.js";

const databaseUrl=process.env.DATABASE_URL;if(!databaseUrl)throw new Error("DATABASE_URL is required");
const pool=new pg.Pool({connectionString:databaseUrl,max:4});const suffix=randomUUID().replaceAll("-","").slice(0,16);
const scope=`operational-provider-${suffix}`;const taskId=`provider-task-${suffix}`;const eventId=`provider-event-${suffix}`;
const eventTime=new Date(Date.now()-30_000).toISOString();const receivedTime=new Date().toISOString();
const transportToken="OperationalProviderTransportToken_2026_Test";let providerApp;let gatewayApp;
try{
  await pool.query("INSERT INTO data_scope(scope_key,operational_domain,description) VALUES ($1,'TEST','Operational Provider E2E')",[scope]);
  const events=new OperationalEventRepository(pool);const projections=new OperationalProjectionRepository(pool);
  const claim={claimId:`claim-${suffix}`,externalAuthority:"planner-provider-e2e",externalKind:"PLANNING_TASK" as const,
    externalValue:`planning-${suffix}`,relationHint:"REPORTS_EXECUTION_OF" as const,matchBasis:"PROPAGATED_CORRELATION_ID" as const,
    confidence:1,observedAt:eventTime,receivedAt:receivedTime,evidenceIds:[`evidence-${suffix}`]};
  await events.insert({dataScopeKey:scope,sourceAuthority:"provider-e2e",sourceEventKey:eventId,sourceRevisionNo:1,eventId,
    operationalTaskId:taskId,eventType:"EXECUTION_STOPPED_OBSERVED",eventTime,actorReferenceKeys:[],targetReferenceKeys:[],
    payload:{taskType:"PROVIDER_E2E"},confidence:1,provenance:[{evidenceId:`evidence-${suffix}`,authority:"provider-e2e",evidenceType:"PROVIDER_EVENT",observedAt:eventTime}],correlationClaims:[claim]},receivedTime);
  await projections.projectPending(100);const snapshot=await projections.get(scope,taskId);if(!snapshot)throw new Error("provider E2E snapshot missing");
  await pool.query(`INSERT INTO operational_source_health_revision(data_scope_key,source_authority,health_status,valid_from,observed_at,evidence_id)
    VALUES ($1,'provider-e2e','HEALTHY',clock_timestamp()-interval '1 hour',clock_timestamp(),$2)`,[scope,`health-${suffix}`]);
  await pool.query(`INSERT INTO operational_source_watermark_revision(data_scope_key,source_authority,closed_through_event_time,allowed_lateness,completeness_state,evidence_id)
    VALUES ($1,'provider-e2e',clock_timestamp()+interval '1 hour',interval '5 seconds','COMPLETE',$2)`,[scope,`watermark-${suffix}`]);
  await pool.query(`INSERT INTO operational_coverage_evidence(data_scope_key,subject_reference_key,source_authority,valid_time,coverage_sufficient,evidence_id,policy_version)
    VALUES ($1,$2,'provider-e2e',tstzrange(clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','[)'),true,$3,'coverage-v1')`,[scope,snapshot.referenceKey.id,`coverage-${suffix}`]);

  const provider=createOperationalRealityProvider({pool});providerApp=buildOperationalRealityApp(provider,transportToken);
  await providerApp.listen({host:"127.0.0.1",port:0});const providerAddress=providerApp.server.address();
  if(!providerAddress||typeof providerAddress==="string")throw new Error("provider address unavailable");
  const endpoint=new URL(`http://127.0.0.1:${providerAddress.port}/`);
  const client=new HttpProviderClient({endpoint,providerId:"gowm.operational-reality",providerVersion:"1.0.0",
    implementationDigest:provider.runtime.manifest.provider.implementationDigest,manifestHash:sha256(provider.runtime.manifest),
    approvedManifest:provider.runtime.manifest,transportToken,allowPlaintextPrivateNetwork:false});
  const registry=new CapabilityRegistry();registry.register({approvalId:"operational-provider-e2e",approved:true,endpoint,client,manifest:provider.runtime.manifest});
  const direct=new DirectExecutionService({registry,circuits:new ProviderCircuitBreaker(),idempotency:new MemoryGatewayIdempotencyStore(),
    audit:new MemoryAuditSink(),gatewayId:"operational-gateway-e2e",policyVersion:"operational-policy-v1",attestationIssuer:"operational-gateway-e2e",records:new MemoryGatewayRecordStore()});
  gatewayApp=buildGatewayApp({registry,directExecution:direct,authenticate:async()=>({principalRef:"operational-e2e",authenticationMethod:"TEST_ATTESTED",authenticatedAt:new Date().toISOString(),dataScopeClaim:scope,allowExperimental:true}),logger:false});
  await gatewayApp.listen({host:"127.0.0.1",port:0});const gatewayAddress=gatewayApp.server.address();
  if(!gatewayAddress||typeof gatewayAddress==="string")throw new Error("gateway address unavailable");const base=`http://127.0.0.1:${gatewayAddress.port}`;
  const deadlineAt=new Date(Date.now()+30_000).toISOString();
  const execute=async(operationId:string,input:unknown,id:string)=>{const descriptor=provider.runtime.manifest.capabilities.find((item)=>item.operationId===operationId);if(!descriptor)throw new Error(`${operationId} missing`);const response=await fetch(`${base}/v1/operations/${operationId}:execute`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requestVersion:"1.0",requestId:id,idempotencyKey:id,operationVersion:"1.0",inputSchemaHash:descriptor.inputSchemaHash,outputSchemaHash:descriptor.outputSchemaHash,input,executionPolicy:{deadlineAt,maximumResultBytes:16777216,maximumRows:1000,maximumCandidates:5000,maximumCostClass:"MEDIUM",preferredExecution:"SYNC"}})});return {status:response.status,replayed:response.headers.get("idempotent-replay")==="true",body:await response.json() as any};};
  const query={schemaVersion:"1.0" as const,referenceKey:snapshot.referenceKey};
  const get=await execute("operational-task.get",query,`get-${suffix}`);const getReplay=await execute("operational-task.get",query,`get-${suffix}`);
  const correlation=await execute("correlation.resolve",{schemaVersion:"1.0",correlationHints:[claim]},`correlation-${suffix}`);
  const predicate=await execute("predicate.evaluate",{predicateId:`predicate-${suffix}`,externalAuthority:"planner-provider-e2e",subject:snapshot.referenceKey,operator:"EVENT_OCCURRED",object:{eventType:"EXECUTION_STOPPED_OBSERVED"},parameters:{expectedSources:["provider-e2e"]}},`predicate-${suffix}`);
  const observed=await execute("observability.evaluate",query,`observability-${suffix}`);
  const failed=await execute("correlation.resolve",{schemaVersion:"1.0"},`failed-${suffix}`);
  if(get.status!==200||get.body.output?.value?.operationalTaskId!==taskId||!getReplay.replayed||correlation.body.output?.value?.relation!=="REPORTS_EXECUTION_OF"||predicate.body.output?.value?.status!=="SUPPORTED"||observed.body.output?.value?.status!=="FRESH"||failed.status!==422||failed.body.error?.providerId!=="gowm.operational-reality")throw new Error(`operational Provider/Gateway E2E invariant failed: ${JSON.stringify({get,getReplay,correlation,predicate,observed,failed})}`);
  process.stdout.write(`${JSON.stringify({result:"OPERATIONAL_PROVIDER_GATEWAY_E2E_PASS",providerId:"gowm.operational-reality",capabilityCount:registry.catalog().length,directGet:get.body.output.value.operationalTaskId,idempotentReplay:getReplay.replayed,correlation:correlation.body.output.value.relation,predicate:predicate.body.output.value.status,observability:observed.body.output.value.status,nodeFailure:{status:failed.status,providerId:failed.body.error.providerId},providerTransport:"HTTP",gatewayTransport:"HTTP"})}\n`);
}finally{await Promise.allSettled([gatewayApp?.close(),providerApp?.close()]);await pool.end();}
