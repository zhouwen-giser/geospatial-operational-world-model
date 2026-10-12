import type { CapabilityDescriptor,GowmTrajectoryArtifactOpenQueryV1,GowmTrajectoryArtifactPageQueryV1 } from '../../../../packages/platform/contract-runtime/src/index.js';
import { getContractSchema,getContractSchemaHash } from '../../../../packages/platform/contract-runtime/src/index.js';
import { declaredSemanticProfile,ProviderProtocolError,sha256,type ProviderOperation } from '../../../../packages/platform/provider-sdk/src/index.js';
import profiles from './semantic-profiles.historical.json' with {type:'json'};
import type { HistoricalArtifactRepository } from './artifact-repository.js';

export function createHistoricalArtifactOperations(repository:HistoricalArtifactRepository):ProviderOperation[] {
  return ['open','read'].map(kind=>{
    const operationId=`history.${kind}-trajectory-artifact`;
    const inputSchemaUri=`urn:gowm:v0.7.1:trajectory-artifact-${kind==='open'?'open':'page'}-query`;
    const outputSchemaUri=`urn:gowm:v0.7.1:trajectory-artifact-${kind==='open'?'open':'page'}-result`;
    const inputSchemaHash=getContractSchemaHash(inputSchemaUri),outputSchemaHash=getContractSchemaHash(outputSchemaUri);
    const descriptor:CapabilityDescriptor={operationId,operationVersion:'1.0',
      semanticProfile:declaredSemanticProfile(profiles,operationId,'1.0'),semanticRole:'DOMAIN_ANALYSIS',dataBinding:'WORLD_SNAPSHOT_BOUND',resultSemantics:'DERIVED_ANALYSIS',
      executionBindings:['SYNC_HTTP','VERSIONED_SQL_CONTRACT'],criticalPathPolicy:'REMOTE_ONLY',maturity:'PREVIEW',inputSchemaUri,inputSchemaHash,outputSchemaUri,outputSchemaHash,
      scopePolicy:'DATA_SCOPE_REQUIRED',execution:{mode:'SYNC',defaultTimeoutMs:kind==='open'?30000:5000,maximumTimeoutMs:30000,costClass:kind==='open'?'HIGH':'MEDIUM'},
      limits:{maximumInputBytes:1048576,maximumOutputBytes:8388608,maximumRows:1000,maximumCandidates:5000},
      snapshotPolicy:{dataSnapshot:'REQUIRED',computeSnapshot:'REQUIRED',resourceResolution:'DISCOVER_RESOURCES'},
      ports:{inputs:[{name:'request',schemaUri:inputSchemaUri,schemaHash:inputSchemaHash,valueKind:'ANY',unitSemantics:'UNSPECIFIED'}],
        outputs:[{name:'result',schemaUri:outputSchemaUri,schemaHash:outputSchemaHash,valueKind:'ANY',unitSemantics:'UNSPECIFIED'}]}};
    return {descriptor,inputSchema:getContractSchema(inputSchemaUri),outputSchema:getContractSchema(outputSchemaUri),recheckOnReplay:true,
      method:{engine:'MobilityDB/PostGIS',engineVersion:'1.3/3.6',methodId:'gowm-history-artifact/pg-jsonb-ndjson-v1',methodVersion:'1.0',
        engineDigest:sha256({encoding:'PG_JSONB_NDJSON_V1',pageSize:256,coordinateEncoding:'POSTGIS_GEOJSON_15_V1',version:'1.0'}),
        artifacts:[{kind:'DATABASE',name:'gowm_history_artifact',version:'migration-090'}]},
      async handle(input,context){
        const scope=context.security.dataScopeClaim,effective=context.snapshots.effective;
        if(!scope)throw new ProviderProtocolError('SCOPE_REQUIRED','artifact requires an authorized data scope');
        if(!effective)throw new ProviderProtocolError('SCHEMA_MISMATCH','artifact requires a frozen query snapshot');
        const result=kind==='open'?await repository.open(input as GowmTrajectoryArtifactOpenQueryV1,scope,effective,context.deadline.remainingMs()):
          await repository.page(input as GowmTrajectoryArtifactPageQueryV1,scope,effective,context.deadline.remainingMs());
        return {status:result.status,value:result.output,dataSnapshot:result.dataSnapshot,consumption:{rows:result.rows,candidates:0},
          warnings:['history.artifactAvailabilityDoesNotProveEvidenceCompleteness=true'],changes:{repairApplied:false,typeChanged:false}};
      }} satisfies ProviderOperation;
  });
}
