import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {canonicalSha256,getContractSchemaHash,validateContract} from '../../packages/platform/contract-runtime/src/index.ts';
import {semanticSourceFingerprint} from '../../packages/platform/semantic-conformance/src/index.ts';
import {createDataSnapshot} from '../../packages/platform/result-validation-core/src/index.ts';

if(process.env.ALLOW_GOWM_WORLD_PLATFORM_CANARY!=='YES') throw new Error('Set ALLOW_GOWM_WORLD_PLATFORM_CANARY=YES for isolated real-process acceptance');
const envPath=process.argv[process.argv.indexOf('--env-file')+1];
if(!process.argv.includes('--env-file')||!envPath)throw new Error('--env-file is required');
const env=Object.fromEntries((await readFile(envPath,'utf8')).split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const reportRoot=process.env.GOWM_REPORT_DIRECTORY?.trim()||'reports/gowm-v0.6.2';
const targetedV063=process.env.GOWM_V063_TARGETED==='YES';
const release=reportRoot.endsWith('v0.6.3')?'v063':'v062';
if(!new RegExp(`^gowm-${release}-[a-z0-9-]+$`,'u').test(env.COMPOSE_PROJECT_NAME))throw new Error('Refusing a non-task Compose project');
const base=`http://127.0.0.1:${env.GATEWAY_PORT}`;
const composeArgs=['compose','--env-file',resolve(envPath),'-f','docker-compose.yml','-f','docker-compose.world-platform.yml','--profile','world-platform'];
const compose=(args,input)=>execFileSync('docker',[...composeArgs,...args],{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],maxBuffer:32*1024*1024});
const sql=(query)=>compose(['exec','-T','postgres','psql','-U','gowm','-d','gowm','-XAt','-v','ON_ERROR_STOP=1'],query).trim();
const literal=(v)=>`'${String(v).replaceAll("'","''")}'`;
const root=resolve('.'), directory=`${reportRoot}/runtime`;
await mkdir(directory,{recursive:true});
const sourceDigest=await semanticSourceFingerprint(root), runId=`${release}-${Date.now()}`;
const seed=JSON.parse(await readFile('validation/fixtures/world-platform-semantic-cases.json','utf8'));
const checks={},executions=[],positive=new Map(),operationTests=new Map(),canaries=[];
let catalog,semantics,queryReplay;
const check=(name,condition,detail)=>{checks[name]=Boolean(condition);if(!condition)throw new Error(`${name}: ${JSON.stringify(detail??null)}`);};
const pause=(ms)=>new Promise(r=>setTimeout(r,ms));
async function http(path,body,headers={}) {
  const response=await fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${env.GATEWAY_AUTH_SHARED_TOKEN}`,...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(120000)});
  return {status:response.status,body:await response.json()};
}
async function ready(){for(let i=0;i<60;i++){try{const r=await http('/health/ready');if(r.status===200)return r.body;}catch{}await pause(500);}throw new Error('Gateway readiness timeout');}
const descriptor=(id)=>{const c=catalog.capabilities.find(c=>c.operationId===id&&c.operationVersion==='1.0');if(!c)throw new Error(`Missing ${id}`);return c;};
function request(id,input,label,overrides={}) {const d=descriptor(id);return {requestVersion:'1.0',requestId:`${runId}-${label}`,idempotencyKey:`${runId}-${label}`,operationVersion:'1.0',inputSchemaHash:d.inputSchemaHash,outputSchemaHash:d.outputSchemaHash,input,executionPolicy:{deadlineAt:new Date(Date.now()+Math.min(60000,d.execution.maximumTimeoutMs)).toISOString(),maximumResultBytes:d.limits.maximumOutputBytes??16777216,maximumRows:d.limits.maximumRows??100000,maximumCandidates:d.limits.maximumCandidates??100000,maximumCostClass:d.execution.costClass,preferredExecution:'SYNC'},...overrides};}
function validateEnvelope(id,envelope,label) {
  const d=descriptor(id), key=`${id}@1.0`;
  check(`${label}:envelope`,validateContract('capability-result-envelope.schema.json',envelope).valid,envelope);
  check(`${label}:receipt`,envelope.receipts?.length>0&&envelope.computeSnapshot?.schemas?.inputSchemaHash===d.inputSchemaHash,envelope);
  if(d.snapshotPolicy.dataSnapshot==='REQUIRED')check(`${label}:snapshot`,envelope.dataSnapshot?.resources?.length>0,envelope);
  if(envelope.output!==undefined){const valid=validateContract(d.outputSchemaUri,envelope.output.value);check(`${label}:outputSchema`,valid.valid,valid.issues);positive.set(id,true);
    const p=d.semanticProfile,output=envelope.output.value;
    if(p.domainStatus){const source=p.domainStatus.path.split('/').slice(1).reduce((values,k)=>values.flatMap(v=>k==='*'?(Array.isArray(v)?v:[]):[v?.[k]]),[output]);check(`${label}:explicit-status-mapping`,source.length>0&&source.every(s=>s!==undefined&&Object.hasOwn(p.domainStatus.mapping,s)),{source,mapping:p.domainStatus.mapping});}
    if(p.spatialSemantics==='CANDIDATE')check(`${label}:candidate-not-fact`,p.resultNature!=='FACT');
    const references=[];const visit=v=>{if(!v||typeof v!=='object')return;if(v.namespace&&v.kind&&v.id&&v.version)references.push(v);Object.values(v).forEach(visit);};visit(output);
    check(`${label}:produced-reference-kinds`,references.every(r=>p.producedReferenceKinds.includes(r.kind)),references);
  }
  operationTests.set(key,[...(operationTests.get(key)??[]),label]);
}
async function execute(id,input,label,allowFailure=false){
  const validation=validateContract(descriptor(id).inputSchemaUri,input);check(`${label}:inputSchema`,validation.valid,validation.issues);
  const response=await http(`/v1/operations/${id}:execute`,request(id,input,label));
  executions.push({operationId:id,label,inputHash:canonicalSha256(input),...response});
  if(!allowFailure){check(`${label}:http`,response.status===200,response);validateEnvelope(id,response.body,label);check(`${label}:completed`,['COMPLETED','NO_DATA','PARTIAL'].includes(response.body.status),response.body);}
  return response;
}
const value=(response)=>response.body.output?.value;
function port(p){const {schemaUri,schemaHash,valueKind,unitSemantics}=p;return {schemaUri,schemaHash,valueKind,unitSemantics};}
function literalBinding(v,targetPath){const uri=`urn:gowm:v0.2:value:${Array.isArray(v)?'array':typeof v}`;return {kind:'LITERAL',value:v,...(targetPath?{targetPath}:{}),port:{schemaUri:uri,schemaHash:getContractSchemaHash(uri),valueKind:'ANY',unitSemantics:'UNSPECIFIED'}};}
function inputFields(input){return Object.fromEntries(Object.entries(input).map(([k,v])=>[k,literalBinding(v,`/${k}`)]));}
function from(nodeId,operationId,portName,targetPath){const p=descriptor(operationId).ports.outputs.find(p=>p.name===portName);if(!p)throw new Error(`Missing ${operationId} port ${portName}`);return {kind:'NODE_OUTPUT',nodeId,outputPort:portName,...(p.path?{path:p.path}:{}),...(targetPath?{targetPath}:{}),port:port(p)};}
function node(nodeId,id,inputs){const d=descriptor(id);return {nodeId,operation:{operationId:id,operationVersion:'1.0',inputSchemaHash:d.inputSchemaHash,outputSchemaHash:d.outputSchemaHash},inputs,failurePolicy:'FAIL_FAST',budget:{maximumRows:d.limits.maximumRows??100000,maximumCandidates:d.limits.maximumCandidates??100000,maximumOutputBytes:d.limits.maximumOutputBytes??16777216,maximumExecutionMs:Math.min(120000,d.execution.maximumTimeoutMs)}};}
async function dag(label,nodes,outputNode,outputOperation,expectedStatus='COMPLETED'){
  const submission={requestId:`${runId}-${label}`,idempotencyKey:`${runId}-${label}`,snapshotPolicy:{mode:'BEST_EFFORT',allowDowngrade:true},parameterSchemaHash:getContractSchemaHash('world-query-parameters.schema.json'),parameters:{},plan:{queryPlanVersion:'2.0',queryId:`query-${runId}-${label}`,nodes,outputs:[{name:'value',binding:from(outputNode,outputOperation,'result')}],budgets:{maximumNodes:nodes.length,maximumDepth:nodes.length,maximumRows:1000000,maximumCandidates:1000000,maximumOutputBytes:67108864,maximumExecutionMs:300000}}};
  const queued=await http('/v1/world-queries',submission,{prefer:'respond-async'});check(`${label}:queued`,queued.status===202,queued);
  let job;
  for(let i=0;i<240;i++){const r=await http(`/v1/jobs/${queued.body.jobId}`);check(`${label}:jobReadable`,r.status===200,r);job=r.body;if(!['QUEUED','RUNNING','SUBMITTED'].includes(job.status))break;await pause(250);}
  const result=job?.result;check(`${label}:jobCompleted`,result?.status===expectedStatus,{job});
  for(const n of result.nodes){const id=nodes.find(x=>x.nodeId===n.nodeId).operation.operationId;if(expectedStatus==='COMPLETED')validateEnvelope(id,n.result,`${label}:${n.nodeId}`);executions.push({operationId:id,label:`${label}:${n.nodeId}`,inputHash:n.inputHash,status:200,body:n.result??n});}
  queryReplay={submission,jobId:job.jobId,resultHash:canonicalSha256(result)};
  return result.outputs.value;
}
const mention=(name,kind='WORLD_OBJECT')=>({schemaVersion:'1.0',mentions:[{mentionId:'m1',surfaceText:name,expectedKinds:[kind]}],context:{anchorReferenceKeys:[]},limitPerMention:10});
async function unique(name,kind){const r=value(await execute('reference.resolve',mention(name,kind),`resolve-${name}`));check(`${name}:unique`,r.resolutions[0].candidates.length===1&&['RESOLVED_EXACT','SUGGESTED_UNIQUE'].includes(r.resolutions[0].status),r);return r.resolutions[0].candidates[0].candidate.referenceKey;}
const snapshot={networkDatasetVersion:'dataset-v1',graphVersion:'graph-v1',travelProfileVersion:'travel-v1',costProfileVersion:'cost-v1',graphContentHash:`sha256:${'1'.repeat(64)}`,costContentHash:`sha256:${'2'.repeat(64)}`};
const state=(digit,fractionPpm=1000000)=>({arcKey:`arc_${digit.repeat(64)}`,fractionPpm,direction:'FORWARD'});
const coverageRequest=(area)=>({schemaVersion:'1.0',requestId:`${runId}-coverage`,routingSnapshot:snapshot,area,routeCount:1,selectionPolicy:{mode:'FULLY_COVERED_EDGE',roadClasses:['LOCAL'],minimumSegmentLengthMm:1,serviceMode:'FIXED_DIRECTION',fixedDirectionSource:'SOURCE_FEATURE_ATTRIBUTE',requiredPasses:1,selectionPolicyVersion:'coverage-selection/1.0'},endpointPolicy:{start:state('1'),entry:{mode:'AUTO',maximumCandidates:8},exit:{mode:'AUTO',maximumCandidates:8},endpointMode:'RETURN_TO_START',boundaryCrossingPolicy:'FREE',snapToleranceMm:1000},objective:{profile:'FASTEST_COMPLETION'},alternativePolicy:{requestedCount:2,minimumVerifiedCount:2,profiles:['SHORTEST_TOTAL_DISTANCE','FASTEST_COMPLETION'],maximumWeightedArcOverlapPpm:800000,minimumDeadheadJaccardDistancePpm:100000},timeLimitMs:60000});
const routeRequest={requestId:`run-${runId}`,routingSnapshot:snapshot,start:state('1'),destination:state('5'),travelProfile:'travel-v1',costProfile:'cost-v1',objective:'SHORTEST_DISTANCE',deadlineMs:10000};
async function validateResult(key,label){const r=value(await execute('result.validate',{schemaVersion:'1.0',references:[{referenceKey:key,requireCurrentSnapshot:true}]},label));check(`${label}:usable`,r.results[0].usable==='YES',r);return r;}
try {
  await ready();catalog=(await http('/v1/capabilities')).body;semantics=(await http('/v1/capability-semantics')).body;
  const imageHashProgram="const fs=require('node:fs'),c=require('node:crypto'),out={};function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=p+'/'+e.name;if(e.isDirectory())walk(f);else if(/\\.(js|json)$/.test(f))out[f]=c.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}}for(const p of ['dist/packages','dist/services','services/stas/dist'])walk(p);process.stdout.write(JSON.stringify(out));";
  const imageFiles=JSON.parse(compose(['exec','-T','world-capability-gateway','node','-e',imageHashProgram]));
  const runtimeMismatches=[];
  for(const [path,hash] of Object.entries(imageFiles))if(createHash('sha256').update(await readFile(path)).digest('hex')!==hash)runtimeMismatches.push(path);
  check('runtime-image-matches-built-source',Object.keys(imageFiles).length>100&&runtimeMismatches.length===0,runtimeMismatches);
  await writeFile(`${directory}/runtime-image-attestation.json`,JSON.stringify({status:'PASS',sourceDigest,compiledFiles:Object.keys(imageFiles).length,files:imageFiles},null,2)+'\n');
  check('catalog-count',catalog.capabilities.length===122,catalog.capabilities.length);
  const expected=JSON.parse(await readFile(`${reportRoot}/world-platform-registry-build-report.json`,'utf8'));
  check('runtime-contract-revision',catalog.contractCatalogRevision===expected.contractCatalogRevision,{actual:catalog.contractCatalogRevision,expected:expected.contractCatalogRevision});
  check('catalog-redaction',!/https?:\/\/|transportToken|containerName|providerEndpoint/iu.test(JSON.stringify([catalog,semantics])));
  for(const p of semantics.profiles)check(`profile-hash:${p.operationId}`,p.semanticProfileHash===canonicalSha256(descriptor(p.operationId).semanticProfile));
  if(sql("SELECT count(*) FROM data_scope WHERE scope_key='coverage-gateway-runtime'")==='0')sql(await readFile('validation/fixtures/coverage-gateway-runtime.sql','utf8'));
  if(sql("SELECT count(*) FROM world_object WHERE id='v062-vehicle'")==='0')sql(await readFile('validation/fixtures/world-platform-semantic-seed.sql','utf8'));
  const migrations=Number(sql('SELECT count(*) FROM schema_migration'));check('real-postgres-migrations',migrations===(await readdir('database/migrations')).filter(n=>n.endsWith('.sql')).length,migrations);
  // The complete SQL suite runs in fresh/upgrade databases in the schema gate.
  // Its historical fixtures intentionally assume no application rows are present.
  check('route-login-controlled-writes',sql("SELECT (NOT ('default_transaction_read_only=on'=ANY(COALESCE(rolconfig,ARRAY[]::text[]))) AND NOT has_table_privilege('route_planner_provider','public.world_object','INSERT') AND NOT has_table_privilege('route_planner_provider','route_planner_runtime.route_request','INSERT') AND has_function_privilege('route_planner_provider','route_planner_runtime.submit_route_request(text,text,text,text,text,jsonb,text)','EXECUTE'))::text FROM pg_roles WHERE rolname='route_planner_provider'")==='true');
  const processes=compose(['ps','--format','json']).trim().split('\n').map(l=>JSON.parse(l));
  check('real-provider-processes',processes.filter(x=>x.Service.includes('provider')&&x.State==='running').length===13);
  check('single-published-gateway',processes.filter(x=>x.Publishers?.some(p=>p.PublishedPort>0)).map(x=>x.Service).join(',')==='world-capability-gateway');
  await writeFile(`${directory}/processes.json`,JSON.stringify(processes.map(({Service,State,Health,Image,Networks,Publishers})=>({Service,State,Health,Image,Networks,Publishers})),null,2)+'\n');

  const vehicle=await unique('KestrelVehicleZX');
  await execute('reference.get',{schemaVersion:'1.0',referenceKey:vehicle},'A-reference-get');
  const current=value(await execute('world.get-current-state',{schemaVersion:'1.0',referenceKey:vehicle},'A-current'));
  await execute('world.get-provenance',{schemaVersion:'1.0',referenceKey:vehicle},'A-provenance');
  const catalogPage=value(await execute('catalog.search',{schemaVersion:'1.0',limit:10},'A-catalog-search'));
  check('A-catalog-nonempty',catalogPage.items.length>0,catalogPage);
  await execute('catalog.get',{schemaVersion:'1.0',referenceKey:catalogPage.items[0].referenceKey},'A-catalog-get');
  check('A-world-position',current.facts[0].position?.type==='Point',current);
  const nearby=value(await execute('spatial.find-nearby',{location:current.facts[0].position.coordinates,radiusM:50,objectTypes:['CANARY_VEHICLE']},'A-nearby'));
  check('A-nearby-authoritative',JSON.stringify(nearby).includes(seed.referenceKeys.vehicle.id),nearby);
  const aNodes=[node('world','world.get-current-state',{request:{kind:'LITERAL',value:{schemaVersion:'1.0',referenceKey:vehicle},port:port(descriptor('world.get-current-state').ports.inputs[0])}}),node('nearby','spatial.find-nearby',{...inputFields({radiusM:50,objectTypes:['CANARY_VEHICLE']}),location:from('world','world.get-current-state','positionCoordinates','/location')})];
  await dag('A-typed',aNodes,'nearby','spatial.find-nearby');
  canaries.push({id:'A',operations:['reference.resolve','world.get-current-state','spatial.find-nearby'],status:'PASS',evidence:['runtime/executions.json','runtime/semantic-black-box-report.json#A-world-position']});

  const areaKey=await unique('TundraZoneQK');
  const area=value(await execute('world.get-geometry',{schemaVersion:'1.0',referenceKey:areaKey},'B-world-geometry')).facts[0].geometry;
  const cover=value(await execute('h3.geometry.cover',{geometry:area,resolution:seed.resolution},'B-cover'));
  const indexed=value(await execute('h3.index.points',{points:['inside','outside'].map(n=>({longitude:seed.points[n][0],latitude:seed.points[n][1]})),resolution:seed.resolution},'B-candidate-points'));
  check('H3-candidate-false-positive',indexed[0].index===indexed[1].index&&cover.cells.includes(indexed[1].index)&&cover.candidateOnly===true&&cover.exactVerificationRequired===true,{indexed,cover});
  const exact=value(await execute('spatial.find-intersections',{geometry:area,candidateReferences:[seed.referenceKeys.inside,seed.referenceKeys.outside,seed.referenceKeys.boundary],objectTypes:['CANARY_POINT']},'B-exact'));
  check('exact-inside',JSON.stringify(exact).includes(seed.referenceKeys.inside.id),exact);
  check('exact-outside-and-bbox-false-positive',!JSON.stringify(exact).includes(seed.referenceKeys.outside.id),exact);
  const inside=value(await execute('spatial.find-in-area',{geometry:area,objectTypes:['CANARY_POINT']},'B-boundary'));
  check('exact-boundary-covered',JSON.stringify(inside).includes(seed.referenceKeys.boundary.id),inside);
  const truth=sql(`SELECT (a.geometry && b.geometry)::text||':'||ST_Intersects(a.geometry,b.geometry)::text FROM world_object_geometry a,world_object_geometry b WHERE a.object_id='v062-area' AND b.object_id='v062-outside'`);
  check('bbox-really-overlaps-without-exact-relation',truth==='true:false',truth);
  await validateResult(seed.referenceKeys.inside,'B-reference-validation');
  canaries.push({id:'B',operations:['reference.resolve','world.get-geometry','h3.geometry.cover','spatial.find-intersections','result.validate'],status:'PASS',evidence:['runtime/executions.json','runtime/semantic-black-box-report.json#H3-candidate-false-positive']});

  if(targetedV063){
    const promoted=['reference.get','reference.resolve','world.get-current-state','world.get-geometry','world.get-provenance','catalog.get','catalog.search','spatial.find-nearby','spatial.find-in-area','spatial.find-intersections'];
    for(const id of promoted){
      check(`promoted-stable:${id}`,descriptor(id).maturity==='STABLE',descriptor(id));
      check(`promoted-positive:${id}`,positive.has(id),[...positive.keys()]);
      const forged=await http(`/v1/operations/${id}:execute`,request(id,{},`targeted-forged-${id}`,{inputSchemaHash:`sha256:${'0'.repeat(64)}`}));
      check(`promoted-forged-contract:${id}`,forged.status>=400&&forged.body.output===undefined,forged);
    }
    const available=await http('/v1/operation-availability');
    check('availability-http',available.status===200,available);
    check('availability-targets',promoted.every(id=>available.body.operations.some(item=>item.operationId===id&&item.availability==='AVAILABLE')),available.body);
    check('availability-no-topology',!/https?:\/\/|providerId|endpoint|containerName/iu.test(JSON.stringify(available.body)),available.body);
    compose(['stop','reference-catalog-provider']);
    try{
      await pause(5200);
      const referenceUnavailable=await http('/v1/operation-availability/reference.get/1.0');
      const spatialAvailable=await http('/v1/operation-availability/spatial.find-nearby/1.0');
      check('availability-local-failure',referenceUnavailable.body.availability==='UNAVAILABLE',referenceUnavailable);
      check('availability-failure-isolated',spatialAvailable.body.availability==='AVAILABLE',spatialAvailable);
    }finally{compose(['start','reference-catalog-provider']);}
    await pause(5200);
    check('availability-recovery',(await http('/v1/operation-availability/reference.get/1.0')).body.availability==='AVAILABLE');
    const beforeJob=queryReplay;
    compose(['restart','world-capability-gateway']);await ready();
    const persisted=await http(`/v1/jobs/${beforeJob.jobId}`);
    check('snapshot-restart-job-preserved',persisted.status===200&&canonicalSha256(persisted.body.result)===beforeJob.resultHash,persisted);
    check('snapshot-manifest-preserved',persisted.body.result.snapshotManifest?.manifestHash===beforeJob.submission.snapshotPolicy?.pinnedSnapshot?.manifestHash||persisted.body.result.snapshotManifest?.manifestHash!==undefined,persisted.body.result);
    const replayed=await http('/v1/world-queries',beforeJob.submission,{prefer:'respond-async'});
    check('snapshot-idempotent-replay',[200,202].includes(replayed.status),replayed);
    const operationEvidence=Object.fromEntries(promoted.map(id=>[`${id}@1.0`,{status:'PASS',sourceDigest,contractHash:canonicalSha256(descriptor(id)),tests:operationTests.get(`${id}@1.0`)??[]} ]));
    await writeFile(`${reportRoot}/black-box-evidence.json`,JSON.stringify({status:'PASS',sourceDigest,runId,operations:operationEvidence},null,2)+'\n');
    canaries.push(
      {id:'C',operations:promoted,status:'PASS',evidence:['runtime/executions.json']},
      {id:'D',operations:['world-query.snapshot'],status:'PASS',evidence:['runtime/semantic-black-box-report.json#snapshot-restart-job-preserved']},
      {id:'E',operations:['operation-availability'],status:'PASS',evidence:['runtime/semantic-black-box-report.json#availability-local-failure']}
    );
  }else{
  const snapRequest={routingSnapshot:snapshot,location:{coordinates:current.facts[0].position.coordinates,crs:'EPSG:4326'},maxDistanceM:10,limit:5};
  const snapped=value(await execute('network.snap.point',snapRequest,'C-snap'));check('C-directed-state',snapped.candidates.length>0,snapped);
  const plan=value(await execute('route.plan',{...routeRequest,start:snapped.candidates[0].state},'C-route'));check('C-route-completed',plan.status==='COMPLETED'&&plan.candidates.length>0,plan);
  await validateResult(plan.queryResultReferenceKey,'C-route-validation');
  const cNodes=[aNodes[0],node('snap','network.snap.point',{...inputFields({routingSnapshot:snapshot,maxDistanceM:10,limit:5}),coordinates:from('world','world.get-current-state','positionCoordinates','/location/coordinates'),crs:literalBinding('EPSG:4326','/location/crs')}),node('route','route.plan',{...inputFields(routeRequest),start:from('snap','network.snap.point','directedState','/start')})];
  await dag('C-typed',cNodes,'route','route.plan');
  canaries.push({id:'C',operations:['world.get-current-state','network.snap.point','route.plan','result.validate'],status:'PASS',evidence:['runtime/executions.json']});

  const coverageArea=await unique('OrchardSectorJV','LAYER_FEATURE'),coverage=coverageRequest(coverageArea);
  check('D-area-reference',coverageArea.kind==='LAYER_FEATURE',coverageArea);
  check('coverage-validate',value(await execute('coverage.road.validate',coverage,'D-validate')).valid===true);
  const obligations=value(await execute('coverage.road.select-obligations',coverage,'D-obligations'));check('coverage-obligations',obligations.obligationCount>0,obligations);
  const covered=await dag('D-coverage',[node('plan','coverage.road.plan',{request:{kind:'LITERAL',value:coverage,port:port(descriptor('coverage.road.plan').ports.inputs[0])}})],'plan','coverage.road.plan');
  check('D-coverage-plan',covered.status==='SUCCEEDED'&&covered.alternatives.length>0,covered);
  await validateResult(covered.referenceKey,'D-result-validation');
  check('coverage-verify',value(await execute('coverage.road.verify',{schemaVersion:'1.0',problemReference:covered.referenceKey,candidate:covered.alternatives[0],routingSnapshot:snapshot,revalidateAgainstCurrentCondition:true},'D-verify')).status==='VALID');
  const expanded=value(await execute('coverage.road.expand-geojson',{schemaVersion:'1.0',resultSetReferenceKey:covered.referenceKey,alternativeId:covered.alternatives[0].alternativeId,include:['AREA','SEGMENTS']},'D-expand'));check('coverage-expanded',expanded.type==='FeatureCollection'&&expanded.features.length>0,expanded);
  canaries.push({id:'D',operations:['reference.resolve','coverage.road.plan','result.validate'],status:'PASS',evidence:['runtime/executions.json']});

  // Generated from Stable descriptors; a missing positive case is release-blocking.
  for(const id of ['network.graph.get','network.graph.list','network.graph.diagnose','network.snap.points','network.connectivity.inspect'])await execute(id,snapRequest,`positive-${id}`);
  const path=value(await execute('network.path.shortest',{routingSnapshot:snapshot,start:state('1'),destination:state('5'),objective:'SHORTEST_DISTANCE'},'positive-network-shortest'));
  check('network-path-found',path.status==='FOUND'||path.status==='COMPLETED',path);
  await execute('network.path.expand',path,'positive-network-expand');
  check('network-independent-verify',value(await execute('network.path.verify',path,'positive-network-verify')).status==='VALID');
  check('route-validate',value(await execute('route.validate',routeRequest,'positive-route-validate')).status==='VALID');
  check('route-independent-verify',value(await execute('route.verify',plan,'positive-route-verify')).status==='VALID');
  const validated=value(await execute('reference.validate',{schemaVersion:'1.0',references:[{referenceKey:seed.coverageAreaReference,requireCurrentSnapshot:true}]},'positive-reference-validate'));check('reference-authority',validated.results[0].usable==='YES',validated);
  const resource={referenceKey:seed.coverageAreaReference,resourceKind:'LAYER_FEATURE',resourceId:seed.coverageAreaReference.id,version:'feature-v1',contentHash:`sha256:${'c'.repeat(64)}`};
  const dataSnapshot=createDataSnapshot('PINNED',[resource]);sql(`SELECT register_platform_data_snapshot('coverage-gateway-runtime','tenant-a',${literal(JSON.stringify(dataSnapshot))}::jsonb)`);
  check('snapshot-get',value(await execute('snapshot.get',{schemaVersion:'1.0',snapshotId:dataSnapshot.snapshotId},'positive-snapshot-get')).snapshotHash===dataSnapshot.snapshotHash);
  check('snapshot-current',value(await execute('snapshot.validate',{schemaVersion:'1.0',snapshot:dataSnapshot},'positive-snapshot-current')).status==='CURRENT');
  const unknown=createDataSnapshot('PINNED',[{resourceKind:'UNKNOWN_RESOURCE',resourceId:'unresolvable',version:'1'}]);
  check('snapshot-unknown',value(await execute('snapshot.validate',{schemaVersion:'1.0',snapshot:unknown},'negative-snapshot-unknown')).status==='UNKNOWN');
  const ambiguous=value(await execute('reference.resolve',mention('SaffronDuplicate'),'negative-reference-ambiguous'));check('reference-ambiguous',ambiguous.resolutions[0].status==='AMBIGUOUS'&&ambiguous.resolutions[0].candidates.length===2,ambiguous);
  for(const name of ['AbsolutelyMissingCanaryZxyz','HiddenForeignRPT']){const r=value(await execute('reference.resolve',mention(name),`negative-${name}`));check(`reference-opaque:${name}`,r.resolutions[0].status==='UNRESOLVED'&&r.resolutions[0].candidates.length===0,r);}
  const missing=await execute('world.get-current-state',{schemaVersion:'1.0',referenceKey:{...seed.referenceKeys.vehicle,id:`wrf_${'f'.repeat(32)}`}},'negative-world-no-data');
  check('NO_DATA-is-unknown',missing.body.status==='NO_DATA'&&value(missing).facts.length===0&&value(missing).unknowns.length>0,missing);

  const noPath=value(await execute('route.plan',{...routeRequest,requestId:`${runId}-unreachable`,start:state('5'),destination:state('1',0)},'negative-plan-no-path'));
  check('plan-no-feasible-domain-result',noPath.status==='NO_PATH'&&noPath.candidates.length===0,noPath);
  const noFeasible=value(await execute('result.validate',{schemaVersion:'1.0',references:[{referenceKey:noPath.queryResultReferenceKey}]},'negative-no-feasible-validation'));
  check('plan-no-feasible-normalized',noFeasible.results[0].resultSemantics?.normalizedStatus==='NO_FEASIBLE_RESULT',noFeasible);
  sql(`INSERT INTO spatial_feature_version(feature_id,layer_id,layer_version_id,version,geometry,properties,valid_from,valid_to,content_hash,published_at)
    SELECT feature_id,layer_id,layer_version_id,'feature-v2',geometry,properties||'{"evolved":true}'::jsonb,valid_from,valid_to,
      'sha256:'||encode(digest(content_hash||':v062-feature-v2','sha256'),'hex'),clock_timestamp()
    FROM spatial_feature_version WHERE feature_id=(SELECT feature_id FROM spatial_feature_identity WHERE reference_key=${literal(seed.coverageAreaReference.id)}) AND version='feature-v1'
    ON CONFLICT(feature_id,version) DO NOTHING`);
  check('snapshot-stale-after-authority-change',value(await execute('snapshot.validate',{schemaVersion:'1.0',snapshot:dataSnapshot},'negative-snapshot-stale')).status==='STALE');
  const staleArea=value(await execute('result.validate',{schemaVersion:'1.0',references:[{referenceKey:covered.referenceKey,requireCurrentSnapshot:true}]},'negative-plan-area-stale'));
  check('coverage-area-change-invalidates-currentness',staleArea.results[0].snapshot==='STALE'&&staleArea.results[0].usable!=='YES',staleArea);

  for(const c of catalog.capabilities.filter(c=>c.maturity==='STABLE')) {
    check(`stable-positive:${c.operationId}`,positive.has(c.operationId));
    const r=await http(`/v1/operations/${c.operationId}:execute`,request(c.operationId,{},`generated-hash-${c.operationId}`,{inputSchemaHash:`sha256:${'0'.repeat(64)}`}));
    check(`generated-forged-contract:${c.operationId}`,r.status>=400&&r.body.output===undefined,r);
    operationTests.set(`${c.operationId}@1.0`,[...operationTests.get(`${c.operationId}@1.0`),`generated-forged-contract:${c.operationId}`]);
  }
  const analytics={records:[{cell:seed.candidateCell}],operation:'count',resolution:9};
  await execute('h3.analytics.aggregate',analytics,'E-before');
  const revision=catalog.contractCatalogRevision;
  compose(['stop','h3-analysis-provider']);
  try {
    check('E-gateway-live',(await http('/health/live')).status===200);check('E-gateway-ready',(await http('/health/ready')).status===200);
    const health=(await http('/health')).body;check('E-health-inventory',health.status==='degraded'&&health.providers['gowm.h3.analysis.bridge'].ready===false,health);
    await execute('reference.resolve',mention('KestrelVehicleZX'),'E-reference');await execute('world.get-current-state',{schemaVersion:'1.0',referenceKey:vehicle},'E-world');await execute('spatial.find-nearby',{location:current.facts[0].position.coordinates,radiusM:50},'E-spatial');
    const failed=await execute('h3.analytics.aggregate',analytics,'E-local-failure',true);check('E-localized-failure',failed.status>=400||failed.body.status==='FAILED',failed);
    check('E-revision-invariant',(await http('/v1/capabilities')).body.contractCatalogRevision===revision);
  } finally {compose(['start','h3-analysis-provider']);}
  canaries.push({id:'E',operations:['h3.analytics.aggregate','reference.resolve','world.get-current-state','spatial.find-nearby'],status:'PASS',evidence:['runtime/executions.json','runtime/semantic-black-box-report.json#E-localized-failure']});

  compose(['stop','route-planning-provider']);
  try {
    await dag('failed-plan-infrastructure',[node('plan','route.plan',{request:{kind:'LITERAL',value:{...routeRequest,requestId:`${runId}-failed`},port:port(descriptor('route.plan').ports.inputs[0])}})],'plan','route.plan','FAILED');
    check('plan-infrastructure-maps-FAILED',true);
  } finally {compose(['start','route-planning-provider']);}

  const beforeJob=queryReplay;compose(['restart','world-capability-gateway']);await ready();
  check('restart-contract-revision',(await http('/v1/capabilities')).body.contractCatalogRevision===revision);
  const persisted=await http(`/v1/jobs/${beforeJob.jobId}`);check('restart-job-preserved',persisted.status===200&&canonicalSha256(persisted.body.result)===beforeJob.resultHash,persisted);
  const replayed=await http('/v1/world-queries',beforeJob.submission,{prefer:'respond-async'});check('restart-idempotent-replay',[200,202].includes(replayed.status)&&((replayed.body.queryId===beforeJob.submission.plan.queryId)||(replayed.body.jobId===beforeJob.jobId)),replayed);
  check('source-remained-frozen',await semanticSourceFingerprint(root)===sourceDigest);
  for(const required of ['exact-inside','exact-outside-and-bbox-false-positive','exact-boundary-covered','H3-candidate-false-positive','bbox-really-overlaps-without-exact-relation','reference-ambiguous','snapshot-current','snapshot-stale-after-authority-change','snapshot-unknown','plan-no-feasible-normalized','plan-infrastructure-maps-FAILED','NO_DATA-is-unknown','restart-job-preserved'])check(`required-semantic-case:${required}`,checks[required]===true);
  const operations=Object.fromEntries(catalog.capabilities.filter(c=>c.maturity==='STABLE').map(c=>[`${c.operationId}@1.0`,{status:'PASS',sourceDigest,contractHash:canonicalSha256(c),tests:operationTests.get(`${c.operationId}@1.0`)}]));
  await writeFile(`${reportRoot}/black-box-evidence.json`,JSON.stringify({status:'PASS',sourceDigest,runId,operations},null,2)+'\n');
  check('complete-canaries',canaries.length===5);
  }
  check('source-remained-frozen',await semanticSourceFingerprint(root)===sourceDigest);
} catch(error){checks.executionCompleted=false;process.stderr.write(`${error.stack??error}\n`);process.exitCode=1;}
finally {
  const status=Object.values(checks).every(Boolean)&&canaries.length===5?'PASS':'FAIL';
  await writeFile(`${directory}/executions.json`,JSON.stringify(executions,null,2)+'\n');
  await writeFile(`${directory}/semantic-black-box-report.json`,JSON.stringify({schemaVersion:'1.0',status,runId,sourceDigest,gatewayBaseUrlHash:canonicalSha256(base),checks,positiveOperations:[...positive.keys()].sort()},null,2)+'\n');
  const report={schemaVersion:'1.0',gatewayBaseUrlHash:canonicalSha256(base),canaries:[...canaries,...['A','B','C','D','E'].filter(id=>!canaries.some(c=>c.id===id)).map(id=>({id,operations:[],status:'FAIL',evidence:['runtime/semantic-black-box-report.json']}))],status};
  if(!validateContract('urn:gowm:v0.6.2:single-gateway-canary-report',report).valid)throw new Error('Canary report contract mismatch');
  await writeFile(`${reportRoot}/single-gateway-canary-report.json`,JSON.stringify(report,null,2)+'\n');
  process.stdout.write(`WORLD_PLATFORM_CANARY_${status} checks=${Object.keys(checks).length} positiveOperations=${positive.size}\n`);
}
