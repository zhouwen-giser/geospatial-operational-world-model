import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {sha256} from '../packages/platform/provider-sdk/src/index.js';

const manifest=JSON.parse(await readFile('contracts/manifests/providers/historical-trace-provider.json','utf8'));
const operations=manifest.capabilities.filter((v:{operationId:string})=>['history.open-trajectory-artifact','history.read-trajectory-artifact'].includes(v.operationId));
if(operations.length!==2)throw Error('ARTIFACT_OPERATION_SET_REQUIRED');
const lock={schemaVersion:'1.0',contractId:'gowm-historical-trajectory-artifact-v1',maturity:'PREVIEW',formalQualification:'NOT_GRANTED',
 providerId:manifest.provider.providerId,providerVersion:manifest.provider.providerVersion,providerManifestHash:sha256(manifest),
 operations:operations.map((v:Record<string,unknown>)=>({operationId:v.operationId,operationVersion:v.operationVersion,inputSchemaUri:v.inputSchemaUri,
  inputSchemaHash:v.inputSchemaHash,outputSchemaUri:v.outputSchemaUri,outputSchemaHash:v.outputSchemaHash,semanticProfileHash:sha256(v.semanticProfile)})),
 format:{mediaType:'application/x-ndjson',encoding:'PG_JSONB_NDJSON_V1',coordinates:'POSTGIS_GEOJSON_15_V1',time:'UTC_MICROSECONDS',
  pageOrder:'MANIFEST_THEN_SEGMENT_ORDINAL_THEN_NODE_ORDINAL',pageSize:256,maximumGeometryNodes:250000,maximumBytes:67108864},
 binding:{fullRequest:'EXACT_FULL_REQUEST_HASH',snapshot:'FROZEN_MANIFEST_AND_RESOURCE_PINS',trajectory:'EXACT_IMMUTABLE_REVISION',
  scope:'AUTHORIZED_DATA_SCOPE',lifetime:'SERVER_TTL_NOT_RENEWED_BY_REPLAY',pageIntegrity:'SHA256_OF_UTF8_CONTENT',artifactIntegrity:'SHA256_OF_CONCATENATED_UTF8_PAGES'},
 completeness:'ARTIFACT_AVAILABILITY_DOES_NOT_PROVE_EVIDENCE_COMPLETENESS',
 migration:{path:'database/migrations/090_historical_trajectory_artifact.sql',sha256:createHash('sha256').update(await readFile('database/migrations/090_historical_trajectory_artifact.sql')).digest('hex')},
 explicitNonClaims:['MAP_MATCHING','TEMPORAL_SPATIAL_EVENTS','HISTORICAL_SIGNAL_RANKING','SITE_BUSINESS_ACCEPTANCE','PITR_OR_HA']};
const path='contracts/consumers/historical-trajectory-artifact-v1.json',bytes=JSON.stringify(lock,null,2)+'\n';
if(process.argv.includes('--write'))await writeFile(path,bytes);else if(await readFile(path,'utf8')!==bytes)throw Error('ARTIFACT_CONSUMER_LOCK_STALE');
console.log('PASS: versioned trajectory Artifact consumer lock matches the public manifest and migration');
