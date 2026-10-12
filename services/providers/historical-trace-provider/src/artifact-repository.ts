import type pg from 'pg';
import type {
  DataSnapshotContext,GowmV07QuerySnapshotManifest,GowmTrajectoryArtifactOpenQueryV1,
  GowmTrajectoryArtifactOpenResultV1,GowmTrajectoryArtifactPageQueryV1,GowmTrajectoryArtifactPageResultV1,
  GowmTrajectoryArtifactManifestV1,GowmTrajectoryArtifactReferenceV1
} from '../../../../packages/platform/contract-runtime/src/index.js';
import { ProviderProtocolError,sha256 } from '../../../../packages/platform/provider-sdk/src/index.js';
import { HistoricalTraceRepository,HISTORICAL_TRACE_SQL,historicalSemanticRequestHash } from './repository.js';

export class HistoricalArtifactRepository {
  constructor(private readonly pool:pg.Pool,private readonly history:HistoricalTraceRepository,private readonly ttlSeconds=86400) {
    if(!Number.isInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>604800) throw Error('ARTIFACT_TTL_INVALID');
  }

  async open(input:GowmTrajectoryArtifactOpenQueryV1,scope:string,effective:GowmV07QuerySnapshotManifest,remainingMs:number) {
    const started=performance.now();
    const base=await this.history.execute(input.request,scope,effective,remainingMs);
    const ref=base.output.trajectoryReferenceKey;
    const common={schemaVersion:'1.0' as const,trajectoryReferenceKey:input.trajectoryReferenceKey};
    if(!ref) return {output:{...common,status:base.output.reasonCode==='PROJECTION_PENDING'?'PROJECTION_PENDING':
      base.output.status==='NO_DATA'?'NO_DATA':'INDETERMINATE',reasonCode:base.output.reasonCode} as GowmTrajectoryArtifactOpenResultV1,
      dataSnapshot:base.dataSnapshot,status:base.output.status==='NO_DATA'?'NO_DATA' as const:'INDETERMINATE' as const,rows:0};
    if(ref.namespace!==input.trajectoryReferenceKey.namespace||ref.kind!==input.trajectoryReferenceKey.kind||
        ref.id!==input.trajectoryReferenceKey.id||ref.version!==input.trajectoryReferenceKey.version)
        throw new ProviderProtocolError('REFERENCE_VERSION_MISMATCH','artifact must consume the exact preview trajectory revision');
    const record=await this.transaction(scope,remainingMs-(performance.now()-started),false,async c=>{
      const row=(await c.query('SELECT gowm_history_artifact.open($1::jsonb,$2::jsonb,$3,$4,$5) value',
        [JSON.stringify(input.request),JSON.stringify(effective),ref.id,Number(ref.version),this.ttlSeconds])).rows[0].value;
      if(!row) await c.query(HISTORICAL_TRACE_SQL.enqueueProjection,[scope,input.request.subjectReferenceKey.id,
        input.request.executionIntervalReferenceKey.id,Number(input.request.executionIntervalReferenceKey.version),input.request.phaseScope,
        historicalSemanticRequestHash(input.request),effective.manifestHash,effective.capturedAt,JSON.stringify(input.request),JSON.stringify(effective)]);
      return row;
    });
    if(!record) return {output:{...common,status:'PROJECTION_PENDING',reasonCode:'REQUEST_EVALUATION_PENDING'} as GowmTrajectoryArtifactOpenResultV1,
      dataSnapshot:base.dataSnapshot,status:'INDETERMINATE' as const,rows:0};
    const artifactReference:GowmTrajectoryArtifactReferenceV1={artifactId:String(record.artifactId),digest:record.digest,
      mediaType:'application/x-ndjson',snapshotManifestHash:record.snapshotManifestHash,fullRequestHash:record.fullRequestHash};
    return {output:{...common,status:'READY',reasonCode:'IMMUTABLE_ARTIFACT_AVAILABLE',artifactReference,
      byteLength:Number(record.byteLength),pageCount:Number(record.pageCount),expiresAt:String(record.expiresAt),
      manifest:record.header as GowmTrajectoryArtifactManifestV1} satisfies GowmTrajectoryArtifactOpenResultV1,
      dataSnapshot:base.dataSnapshot,status:'COMPLETED' as const,rows:1};
  }

  async page(input:GowmTrajectoryArtifactPageQueryV1,scope:string,effective:GowmV07QuerySnapshotManifest,remainingMs:number) {
    const record=await this.transaction(scope,remainingMs,true,async c=>(await c.query(
      'SELECT gowm_history_artifact.read_page($1::jsonb,$2,$3::jsonb) value',
      [JSON.stringify(input.artifactReference),input.pageNo,JSON.stringify(effective)])).rows[0].value);
    const manifest=record.header as GowmTrajectoryArtifactManifestV1;
    const dataSnapshot:DataSnapshotContext={consistency:effective.consistency,capturedAt:effective.capturedAt,
      scopeDigest:sha256({dataScopeKey:scope}),resources:[
        {referenceKey:manifest.trajectoryReferenceKey,pinning:'PINNED',authority:'gowm_history_v1',digest:manifest.trajectoryContentHash,worldVersion:manifest.worldVersion},
        {referenceKey:{namespace:'gowm',kind:'HISTORY_INPUT_SET',id:'input-set-'+manifest.inputSetHash.slice(7),version:manifest.trajectoryReferenceKey.version},
          pinning:'PINNED',authority:'gowm_history_v1',digest:manifest.inputSetHash}
      ]};
    return {output:{schemaVersion:'1.0',status:'READY',artifactReference:input.artifactReference,pageNo:input.pageNo,
      pageDigest:record.pageDigest,content:String(record.content),nextPage:record.nextPage} satisfies GowmTrajectoryArtifactPageResultV1,
      dataSnapshot,status:'COMPLETED' as const,rows:input.pageNo===0?1:String(record.content).split('\n').length-1};
  }

  private async transaction<T>(scope:string,remainingMs:number,readonly:boolean,body:(c:pg.PoolClient)=>Promise<T>):Promise<T> {
    if(!scope.trim())throw new ProviderProtocolError('SCOPE_REQUIRED','authorized scope is required');
    if(remainingMs<=0)throw new ProviderProtocolError('DEADLINE_EXCEEDED','artifact deadline elapsed');
    let c:pg.PoolClient;
    try {c=await this.pool.connect();}catch{
      throw new ProviderProtocolError('PROVIDER_NOT_READY','historical artifact database is unavailable',{retryable:true});
    }
    try {
      await c.query(readonly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
      await c.query(HISTORICAL_TRACE_SQL.setScope,[scope]);
      await c.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','1000ms',true)",[`${Math.max(1,Math.min(30000,Math.floor(remainingMs)))}ms`]);
      const result=await body(c);await c.query('COMMIT');return result;
    }catch(error){
      await c.query('ROLLBACK').catch(()=>{});
      if(error instanceof ProviderProtocolError)throw error;
      const code=(error as {code?:string}).code;
      throw new ProviderProtocolError(code==='42501'?'SCOPE_DENIED':code==='23514'?'REFERENCE_VERSION_MISMATCH':
        code==='P0002'?'VERSION_NOT_FOUND':code==='22023'?'INVALID_REQUEST':code==='54000'?'BUDGET_EXCEEDED':
        code==='57014'?'DEADLINE_EXCEEDED':'PROVIDER_NOT_READY','historical artifact operation failed',{
          retryable:code==='57014',details:{reason:(error as Error).message.startsWith('ARTIFACT_')?(error as Error).message:'ARTIFACT_DATABASE_UNAVAILABLE'},cause:error});
    }finally{c.release();}
  }
}
