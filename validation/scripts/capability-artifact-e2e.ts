import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import pg from 'pg';
import {validateContract,type ProviderExecutionRequest,type GowmV07QuerySnapshotManifest} from '../../packages/platform/contract-runtime/src/index.js';
import {sha256} from '../../packages/platform/provider-sdk/src/index.js';
import {HistoricalProjectionCoordinator,PostgresTaskIntervalProjectionRepository,PostgresTrackletProjectionRepository,
  PostgresHistoricalTrajectoryProjectionRepository,PostgresHistoricalTrajectoryMaterializer} from '../../packages/historical-trace-runtime/src/index.js';
import {createHistoricalTraceProvider} from '../../services/providers/historical-trace-provider/src/provider.js';
import {verifyArtifactGateway} from './capability-artifact-gateway.js';
import {OperationalProjectionRepository} from '../../packages/runtime/src/operational-projection-repository.js';
import {fixtureIdentity,seedFixtureFoundation,seedTaskEvents,seedPositions,insertPosition,seedCompleteWatermark,
  projectFixture,loadIntervalPin,historicalQuery,snapshotManifest} from './history-concurrency-fixture.js';

export async function verifyHistoricalArtifact(databaseUrl:string) {
 const admin=new pg.Pool({connectionString:databaseUrl,max:6});
 const reader=new pg.Pool({connectionString:databaseUrl,max:3,options:'-c role=gowm_history_service'});
 const worker=new pg.Pool({connectionString:databaseUrl,max:4,options:'-c role=gowm_history_worker_service'});
 const checks:string[]=[];const check=(name:string)=>checks.push(name);
 const fixture=fixtureIdentity(randomUUID());
 try {
  await seedFixtureFoundation(admin,fixture);await seedTaskEvents(admin,fixture);await seedPositions(admin,fixture);
  // More geometry than the public preview budget, with an actual manual cut.
  for(let i=0;i<600;i++) await insertPosition(admin,fixture,{ordinal:10+i,
   phenomenonTime:new Date(Date.parse('2026-08-30T00:00:00Z')+1+i*4).toISOString(),x:448000+i*0.001+(i%2)*0.0005});
  await insertPosition(admin,fixture,{ordinal:900,phenomenonTime:'2026-08-30T00:00:08.000Z',x:448008,manualCutBefore:true});
  await seedCompleteWatermark(admin,fixture);
  await new OperationalProjectionRepository(admin).projectPending(100);
  await new Promise(r=>setTimeout(r,1100));
  const core=new HistoricalProjectionCoordinator({intervals:new PostgresTaskIntervalProjectionRepository(worker),tracklets:new PostgresTrackletProjectionRepository(worker)});
  const coreResult=await core.tick({workerId:'artifact-core',batchSize:100,leaseSeconds:60,retryDelayMs:0});
  assert.equal(coreResult.historicalProjectionFailures,0);
  const interval=await loadIntervalPin(admin,fixture),query=historicalQuery(fixture,interval.referenceKey);
  query.maximumInlinePoints=3;
  const snapshot=snapshotManifest(randomUUID(),(await admin.query('SELECT clock_timestamp() t')).rows[0].t.toISOString());
  const provider=createHistoricalTraceProvider({pool:reader,artifactTtlSeconds:60});
  const coordinator=new HistoricalProjectionCoordinator({intervals:new PostgresTaskIntervalProjectionRepository(worker),
   tracklets:new PostgresTrackletProjectionRepository(worker),trajectories:new PostgresHistoricalTrajectoryProjectionRepository(worker),
   materializer:new PostgresHistoricalTrajectoryMaterializer(worker)});
  const pending=await provider.repository.execute(query,fixture.dataScopeKey,snapshot,30000);
  assert.equal(pending.output.reasonCode,'PROJECTION_PENDING');
  const consume=async()=>{for(let n=0;n<20;n++){const r=await coordinator.materializeHistoricalTrajectories({workerId:'artifact-test',batchSize:1,leaseSeconds:60,retryDelayMs:0});assert.equal(r.historicalProjectionFailures,0);if(!r.historicalTrajectoryClaims)break;}};
  await consume();
  const preview=await provider.repository.execute(query,fixture.dataScopeKey,snapshot,30000);
  assert((preview.output.preview?.length??0)>0&&(preview.output.preview?.length??0)<=3);assert(preview.output.trajectoryReferenceKey);
  check('real_worker_evaluation_and_bounded_preview');
  const oldHashes=(await admin.query('SELECT trajectory_revision_id,content_hash,input_set_hash FROM gowm_history.historical_trajectory_revision ORDER BY trajectory_revision_id')).rows;
  const request={request:query,trajectoryReferenceKey:preview.output.trajectoryReferenceKey};
  const invoke=async(operationId:string,input:unknown,scope=fixture.dataScopeKey,effective=snapshot,nonce='artifact-'+randomUUID())=>{
   const descriptor=provider.runtime.manifest.capabilities.find(x=>x.operationId===operationId)!;const now=Date.now();
   const req:ProviderExecutionRequest={providerProtocolVersion:'1.0',requestId:nonce,gatewayRequestId:'gateway-'+nonce,idempotencyKey:nonce,
    operation:{operationId,operationVersion:'1.0',inputSchemaHash:descriptor.inputSchemaHash,outputSchemaHash:descriptor.outputSchemaHash},input,
    securityContext:{principalRef:'principal:artifact-test',authenticationMethod:'TEST_ATTESTED',authenticatedAt:new Date(now-1000).toISOString(),
      dataScopeClaim:scope,scopeAttestation:{issuer:'artifact-test',issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString(),claimDigest:sha256({dataScopeClaim:scope})}},
    gatewayContext:{gatewayId:'artifact-test',registryVersion:'0.7.1',policyVersion:'0.7.1'},effectiveSnapshot:effective,
    executionPolicy:{deadlineAt:new Date(now+30000).toISOString(),maximumInputBytes:1048576,maximumResultBytes:8388608,
     maximumRows:1000,maximumCandidates:5000,maximumCostClass:'HIGH'}};
   return provider.runtime.execute(req);
  };
  const opened=await invoke('history.open-trajectory-artifact',request);
  assert.equal(opened.status,'COMPLETED',JSON.stringify(opened));
  const value=(opened.output as {value:Record<string,any>}).value;
  assert.equal(validateContract('urn:gowm:v0.7.1:trajectory-artifact-open-result',value).valid,true);
  assert(value.manifest.geometryNodeCount>600);assert(value.manifest.gaps.length>0);
  const ref=value.artifactReference;let bytes='';let nodes=0;
  for(let page=0;page<value.pageCount;page++) {
   const result=await invoke('history.read-trajectory-artifact',{artifactReference:ref,pageNo:page});
   assert.equal(result.status,'COMPLETED',JSON.stringify(result));
   const out=(result.output as {value:Record<string,any>}).value;
   assert.equal(validateContract('urn:gowm:v0.7.1:trajectory-artifact-page-result',out).valid,true);
   assert.equal('sha256:'+createHash('sha256').update(out.content).digest('hex'),out.pageDigest);
   assert.equal(out.nextPage,page+1<value.pageCount?page+1:null);bytes+=out.content;
   if(page>0)nodes+=out.content.trim().split('\n').length;
  }
  assert.equal(nodes,value.manifest.geometryNodeCount);assert.equal(Buffer.byteLength(bytes),value.byteLength);
  assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),ref.digest);
  assert.deepEqual(JSON.parse(bytes.split('\n')[0]!),value.manifest);check('public_protocol_full_bytes_pages_digest_gaps');
  const repeat=await provider.artifacts.open(request,fixture.dataScopeKey,snapshot,30000);
  assert.equal(repeat.output.artifactReference?.artifactId,ref.artifactId);check('open_idempotence');
  await assert.rejects(provider.artifacts.page({artifactReference:ref,pageNo:0},'default',snapshot,30000),/failed/);
  for(const changed of [{digest:'sha256:'+'f'.repeat(64)},{fullRequestHash:'sha256:'+'f'.repeat(64)},{snapshotManifestHash:'sha256:'+'f'.repeat(64)}])
   await assert.rejects(provider.artifacts.page({artifactReference:{...ref,...changed},pageNo:0},fixture.dataScopeKey,snapshot,30000),/failed/);
  await assert.rejects(provider.artifacts.page({artifactReference:ref,pageNo:value.pageCount},fixture.dataScopeKey,snapshot,30000),/failed/);
  await assert.rejects(provider.artifacts.open({...request,trajectoryReferenceKey:{...request.trajectoryReferenceKey,version:'999'}},fixture.dataScopeKey,snapshot,30000),/exact preview/);
  const bad=structuredClone(snapshot);bad.resources=[{resourceKind:'HISTORY_INPUT_SET',resourceId:'input-set-'+value.manifest.inputSetHash.slice(7),version:'999',pinning:'PINNED'}];
  const {manifestHash:_,...body}=bad;bad.manifestHash=sha256(body);
  await assert.rejects(provider.artifacts.page({artifactReference:ref,pageNo:0},fixture.dataScopeKey,bad,30000),/failed/);
  check('scope_identity_page_and_snapshot_pin_rejection');
  const later=snapshotManifest(randomUUID(),(await admin.query('SELECT clock_timestamp() t')).rows[0].t.toISOString());
  const laterOpen=await provider.artifacts.open(request,fixture.dataScopeKey,later,30000);
  assert.equal(laterOpen.output.status,'PROJECTION_PENDING');
  await consume();
  const short=createHistoricalTraceProvider({pool:reader,artifactTtlSeconds:1});
  const expires=await short.artifacts.open(request,fixture.dataScopeKey,later,30000);assert(expires.output.artifactReference);
  await short.artifacts.page({artifactReference:expires.output.artifactReference,pageNo:0},fixture.dataScopeKey,later,30000);
  await new Promise(r=>setTimeout(r,1100));
  await assert.rejects(short.artifacts.page({artifactReference:expires.output.artifactReference!,pageNo:0},fixture.dataScopeKey,later,30000),/failed/);
  assert.deepEqual((await admin.query('SELECT trajectory_revision_id,content_hash,input_set_hash FROM gowm_history.historical_trajectory_revision ORDER BY trajectory_revision_id')).rows,oldHashes);
  check('reuse_with_new_evaluation_expiry_and_old_hash_preservation');
  const denied=await admin.query("SELECT has_table_privilege('gowm_history_service','gowm_history_artifact.registry','INSERT') write,has_function_privilege('public','gowm_history_artifact.open(jsonb,jsonb,text,integer,integer)','EXECUTE') public_execute");
  assert.deepEqual(denied.rows[0],{write:false,public_execute:false});check('minimal_privileges');
  const gateway=await verifyArtifactGateway(provider,query,fixture.dataScopeKey,consume);check('real_gateway_http_pinned_preview_open_pending_replay_and_all_pages');
  return {status:'PASS',checks,nodeCount:nodes,pageCount:value.pageCount,bytes:value.byteLength,
   gateway,businessAcceptance:'NOT_RUN',remoteDeployment:'NOT_RUN'};
 } finally {await Promise.all([reader.end(),worker.end(),admin.end()]);}
}

if(process.argv[1]?.endsWith('capability-artifact-e2e.ts')) {
 const url=process.env.GOWM_CAPABILITY_TEST_DATABASE_URL;if(!url)throw Error('GOWM_CAPABILITY_TEST_DATABASE_URL required');
 const result=await verifyHistoricalArtifact(url);await mkdir('reports/capability-completion-2026-10-12',{recursive:true});
 await writeFile('reports/capability-completion-2026-10-12/artifact-postgres.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}
