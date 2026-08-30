import type pg from "pg";
import type { CapabilityDescriptor,CapabilityProviderManifest } from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,declaredSemanticProfile,ProviderProtocolError,sha256,
  type ProviderOperation,type ProviderRuntime
} from "../../../../packages/platform/provider-sdk/src/index.js";
import profiles from "./semantic-profiles.historical.json" with { type:"json" };
import { HistoricalTraceRepository } from "./repository.js";
import { HISTORICAL_TRACE_OPERATION_ID,HISTORICAL_TRACE_SCHEMAS } from "./schemas.js";

export interface HistoricalTraceProvider {
  runtime:ProviderRuntime;repository:HistoricalTraceRepository;
}

export function createHistoricalTraceProvider(options:{
  pool:pg.Pool;now?:()=>Date;receiptId?:()=>string;
}):HistoricalTraceProvider {
  const repository=new HistoricalTraceRepository(options.pool);
  const operation=createHistoricalTraceOperation(repository);
  const manifest:CapabilityProviderManifest={
    providerProtocolVersion:"1.0",manifestSchemaVersion:"1.1",
    provider:{
      providerId:"gowm.historical-trace",providerVersion:"0.7.0",owner:"gowm-platform",
      implementationDigest:sha256({
        providerId:"gowm.historical-trace",providerVersion:"0.7.0",readContract:"gowm_history_v1",
        capability:operation.descriptor,policy:"historical-trace-read-only-v1"
      }),sourceRef:"urn:gowm:source:in-tree:historical-trace:0.7.0"
    },
    endpoints:{
      manifest:"/v1/manifest",liveness:"/health/live",readiness:"/health/ready",
      execute:"/v1/operations/{operationId}:execute",job:"/v1/jobs/{jobId}"
    },capabilities:[operation.descriptor]
  };
  const policy={
    version:"gowm-historical-trace-policy/1.0",scopeBeforeRead:true,asOfEffectiveSnapshot:true,
    providerToProviderCalls:false,naturalLanguageParsing:false,multiSourceFusion:false,projectionWrites:false
  };
  return {
    repository,
    runtime:createProviderRuntime({
      manifest,operations:[operation],policyVersion:policy.version,policyDigest:sha256(policy),
      ...(options.now?{now:options.now}:{}),...(options.receiptId?{receiptId:options.receiptId}:{})
    })
  };
}

function createHistoricalTraceOperation(repository:HistoricalTraceRepository):ProviderOperation {
  const descriptor:CapabilityDescriptor={
    operationId:HISTORICAL_TRACE_OPERATION_ID,operationVersion:"1.0",
    semanticProfile:declaredSemanticProfile(profiles,HISTORICAL_TRACE_OPERATION_ID,"1.0"),
    semanticRole:"DOMAIN_ANALYSIS",dataBinding:"WORLD_SNAPSHOT_BOUND",resultSemantics:"DERIVED_ANALYSIS",
    executionBindings:["SYNC_HTTP","VERSIONED_SQL_CONTRACT"],criticalPathPolicy:"REMOTE_ONLY",maturity:"PREVIEW",
    inputSchemaUri:HISTORICAL_TRACE_SCHEMAS.inputSchemaUri,inputSchemaHash:HISTORICAL_TRACE_SCHEMAS.inputSchemaHash,
    outputSchemaUri:HISTORICAL_TRACE_SCHEMAS.outputSchemaUri,outputSchemaHash:HISTORICAL_TRACE_SCHEMAS.outputSchemaHash,
    scopePolicy:"DATA_SCOPE_REQUIRED",execution:{mode:"SYNC",defaultTimeoutMs:5_000,maximumTimeoutMs:30_000,costClass:"MEDIUM"},
    limits:{maximumInputBytes:1_048_576,maximumOutputBytes:16_777_216,maximumRows:1_000,maximumCandidates:5_000},
    snapshotPolicy:{dataSnapshot:"REQUIRED",computeSnapshot:"REQUIRED",resourceResolution:"DISCOVER_RESOURCES"},
    ports:{
      inputs:[{name:"request",schemaUri:HISTORICAL_TRACE_SCHEMAS.inputSchemaUri,schemaHash:HISTORICAL_TRACE_SCHEMAS.inputSchemaHash,valueKind:"ANY",unitSemantics:"UNSPECIFIED"}],
      outputs:[{name:"result",schemaUri:HISTORICAL_TRACE_SCHEMAS.outputSchemaUri,schemaHash:HISTORICAL_TRACE_SCHEMAS.outputSchemaHash,valueKind:"ANY",unitSemantics:"UNSPECIFIED"}]
    }
  };
  return {
    descriptor,inputSchema:HISTORICAL_TRACE_SCHEMAS.input,outputSchema:HISTORICAL_TRACE_SCHEMAS.output,
    method:{
      engine:"MobilityDB",engineVersion:"1.3",methodId:"gowm-history-v1/gap-preserving-trajectory",methodVersion:"1.0",
      engineDigest:sha256({mobilityDb:"1.3",postgis:"3.6",interpolation:"stored-tracklet-sequences",transform:"PostGIS-ST_Transform-4326"}),
      artifacts:[
        {kind:"DATABASE",name:"gowm_history_v1",version:"migration-067"},
        {kind:"PACKAGE",name:"PostGIS",version:"3.6"},
        {kind:"PACKAGE",name:"gowm-historical-trajectory-algorithm",version:"1.0",digest:sha256({gapPreserving:true,sourceSelection:"projection-owned",asOf:true})},
        {kind:"PACKAGE",name:"gowm-history-method-profile-contract",version:"1.0",digest:sha256({resourceKind:"HISTORY_METHOD_PROFILE",pinning:"PINNED"})}
      ]
    },
    async handle(input,context) {
      const scope=context.security.dataScopeClaim;
      if (!scope) throw new ProviderProtocolError("SCOPE_REQUIRED","authorized data scope is required");
      const effective=context.snapshots.effective;
      if (!effective) throw new ProviderProtocolError("SCHEMA_MISMATCH","effective query snapshot is required for historical as-of selection");
      const result=await repository.execute(input as Parameters<HistoricalTraceRepository["execute"]>[0],scope,effective,context.deadline.remainingMs());
      return {
        status:result.status,value:result.output,dataSnapshot:result.dataSnapshot,
        evidenceReferences:result.evidenceReferences,consumption:{rows:result.rows,candidates:result.candidates},
        warnings:result.warnings,changes:{repairApplied:false,typeChanged:false}
      };
    }
  };
}
