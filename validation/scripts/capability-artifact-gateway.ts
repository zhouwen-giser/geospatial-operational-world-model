import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {getContractSchemaHash,type WorldQuerySubmission,type CapabilityDescriptor,type GowmV07HistoricalTrajectoryQuery,type GowmV071QuerySnapshotManifest} from '../../packages/platform/contract-runtime/src/index.js';
import {sha256,ProviderProtocolError} from '../../packages/platform/provider-sdk/src/index.js';
import {buildHistoricalTraceApp} from '../../services/providers/historical-trace-provider/src/app.js';
import type {HistoricalTraceProvider} from '../../services/providers/historical-trace-provider/src/provider.js';
import {buildGatewayApp,CapabilityRegistry,DirectExecutionService,HttpProviderClient,MemoryAuditSink,
 MemoryGatewayIdempotencyStore,MemoryGatewayRecordStore,MemoryQueryPlanStore,ProviderCircuitBreaker,
 QueryPlanValidator,WorldQueryRuntime,type GatewayPrincipal} from '../../services/gateway/world-capability-gateway/src/index.js';

/** Real HTTP and canonical Gateway execution; only Gateway coordination stores
 * are in-memory. All history, assessment and Artifact facts use real PostgreSQL. */
export async function verifyArtifactGateway(provider:HistoricalTraceProvider,query:GowmV07HistoricalTrajectoryQuery,scope:string,consume:()=>Promise<void>){
 const transport='artifact-test-only-transport-'+randomUUID(),authorization='Bearer artifact-test-only-'+randomUUID();
 const providerApp=buildHistoricalTraceApp(provider,transport);let app:ReturnType<typeof buildGatewayApp>|undefined;
 const origin=(address:unknown)=>new URL('http://127.0.0.1:'+String((address as {port:number}).port));
 try {
  await providerApp.listen({host:'127.0.0.1',port:0});const endpoint=origin(providerApp.server.address()),manifest=provider.runtime.manifest;
  const client=new HttpProviderClient({endpoint,providerId:manifest.provider.providerId,providerVersion:manifest.provider.providerVersion,
   implementationDigest:manifest.provider.implementationDigest,manifestHash:sha256(manifest),approvedManifest:manifest,transportToken:transport});
  const registry=new CapabilityRegistry();registry.register({approvalId:'isolated-artifact-test',approved:true,manifest,endpoint,client});
  const records=new MemoryGatewayRecordStore(),direct=new DirectExecutionService({registry,records,circuits:new ProviderCircuitBreaker(),
   idempotency:new MemoryGatewayIdempotencyStore(),audit:new MemoryAuditSink(),gatewayId:'artifact-gateway-test',policyVersion:'test/1',attestationIssuer:'test'});
  const runtime=new WorldQueryRuntime({validator:new QueryPlanValidator(registry),directExecution:direct,store:new MemoryQueryPlanStore()});
  app=buildGatewayApp({registry,directExecution:direct,records,worldQueries:runtime,authenticate:async req=>{
   if(req.headers.authorization!==authorization)throw new ProviderProtocolError('SCOPE_DENIED','test credential required');
   return {principalRef:'principal:artifact-gateway-test',authenticationMethod:'TEST_ATTESTED',authenticatedAt:new Date().toISOString(),dataScopeClaim:scope,allowExperimental:true} as GatewayPrincipal;
  }});await app.listen({host:'127.0.0.1',port:0});const url=new URL('/v1/world-queries',origin(app.server.address()));
  const submission=(operationId:string,input:unknown,snapshot?:GowmV071QuerySnapshotManifest):WorldQuerySubmission=>{
   const d=manifest.capabilities.find(x=>x.operationId===operationId)!;
   const port=(p:CapabilityDescriptor['ports']['inputs'][number])=>({schemaUri:p.schemaUri,schemaHash:p.schemaHash,valueKind:p.valueKind,unitSemantics:p.unitSemantics});
   const budget={maximumRows:d.limits.maximumRows??1000,maximumCandidates:d.limits.maximumCandidates??5000,maximumOutputBytes:d.limits.maximumOutputBytes??8388608,maximumExecutionMs:d.execution.maximumTimeoutMs};
   return {requestId:'request-'+randomUUID(),idempotencyKey:'idem-'+randomUUID(),parameterSchemaHash:getContractSchemaHash('world-query-parameters.schema.json'),parameters:{},
    snapshotPolicy:snapshot?{mode:'PINNED',pinnedSnapshot:snapshot,allowDowngrade:false}:{mode:'LATEST_AT_START',allowDowngrade:false},
    plan:{queryPlanVersion:'2.0',queryId:'query-'+randomUUID(),nodes:[{nodeId:'artifact',operation:{operationId,operationVersion:d.operationVersion,inputSchemaHash:d.inputSchemaHash,outputSchemaHash:d.outputSchemaHash},
     inputs:{request:{kind:'LITERAL',port:port(d.ports.inputs[0]!),value:input}},failurePolicy:'FAIL_FAST',budget}],
     outputs:[{name:'result',binding:{kind:'NODE_OUTPUT',nodeId:'artifact',outputPort:'result',port:port(d.ports.outputs[0]!)}}],
     budgets:{maximumNodes:1,maximumDepth:1,...budget}}};
  };
  const submit=async(operationId:string,input:unknown,snapshot?:GowmV071QuerySnapshotManifest)=>{
   const response=await fetch(url,{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(submission(operationId,input,snapshot))});
   const body=await response.json() as Record<string,any>;assert.equal(response.status,200,JSON.stringify(body));
   return body;
  };
  const preview=await submit('history.get-trajectory',query);assert(['COMPLETED','PARTIAL'].includes(preview.status),JSON.stringify(preview));
  const frozen=preview.effectiveSnapshotManifest as GowmV071QuerySnapshotManifest;
  assert(frozen.resources.length>0,'Gateway must retain the discovered input pins');
  const input={request:query,trajectoryReferenceKey:preview.outputs.result.trajectoryReferenceKey};
  const pending=await submit('history.open-trajectory-artifact',input,frozen);
  const pendingValue=pending.outputs.result??pending.nodes?.[0]?.result?.output?.value;
  assert.equal(pendingValue?.status,'PROJECTION_PENDING',JSON.stringify(pending));
  await consume();
  const opened=await submit('history.open-trajectory-artifact',input,frozen);assert.equal(opened.status,'COMPLETED',JSON.stringify(opened));
  const artifact=opened.outputs.result;assert.equal(artifact.status,'READY');let bytes='';
  for(let pageNo=0;pageNo<artifact.pageCount;pageNo++){
   const page=await submit('history.read-trajectory-artifact',{artifactReference:artifact.artifactReference,pageNo},frozen);
   assert.equal(page.status,'COMPLETED',JSON.stringify(page));bytes+=page.outputs.result.content;
  }
  assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),artifact.artifactReference.digest);
  assert.equal(Buffer.byteLength(bytes),artifact.byteLength);
  const denied=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(submission('history.get-trajectory',query))});assert.equal(denied.status,403);
  return {status:'PASS',transport:'REAL_GATEWAY_AND_PROVIDER_HTTP',gatewayCoordinationStore:'IN_MEMORY_TEST_ONLY',facts:'REAL_POSTGRES',pages:artifact.pageCount,bytes:artifact.byteLength,frozenPins:frozen.resources.length};
 }finally{if(app)await app.close();await providerApp.close();}
}
