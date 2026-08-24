import type pg from "pg";
import type { CapabilityDescriptor,CapabilityProviderManifest } from "../../../../packages/platform/contract-runtime/src/index.js";
import { createProviderRuntime,sha256,type ProviderOperation,type ProviderRuntime } from "../../../../packages/platform/provider-sdk/src/index.js";
import { OperationalRealityProviderRepository } from "./repository.js";
import { OPERATIONAL_REALITY_OPERATION_IDS,OPERATIONAL_REALITY_SCHEMAS,type OperationalRealityOperationId } from "./schemas.js";

export interface OperationalRealityProvider { runtime:ProviderRuntime;repository:OperationalRealityProviderRepository; }
export function createOperationalRealityProvider(options:{pool:pg.Pool;now?:()=>Date;receiptId?:()=>string}):OperationalRealityProvider {
  const repository=new OperationalRealityProviderRepository(options.pool,options.now);
  const operations=OPERATIONAL_REALITY_OPERATION_IDS.map((id)=>operation(id,repository));
  const manifest:CapabilityProviderManifest={
    providerProtocolVersion:"1.0",provider:{
      providerId:"gowm.operational-reality",providerVersion:"1.0.0",owner:"gowm-platform",
      implementationDigest:sha256({providerId:"gowm.operational-reality",version:"1.0.0",contract:"gowm_operational_reality_v1",operations:operations.map((item)=>item.descriptor)}),
      sourceRef:"urn:gowm:source:in-tree:operational-reality:1.0.0"
    },endpoints:{manifest:"/v1/manifest",liveness:"/health/live",readiness:"/health/ready",execute:"/v1/operations/{operationId}:execute",job:"/v1/jobs/{jobId}"},
    capabilities:operations.map((item)=>item.descriptor)
  };
  const policy={version:"gowm-operational-reality-policy/1.0",scopeBeforeQuery:true,gatewayDomainAlgorithms:false,providerToProviderCalls:false};
  return {repository,runtime:createProviderRuntime({manifest,operations,policyVersion:policy.version,policyDigest:sha256(policy),...(options.now?{now:options.now}:{}),...(options.receiptId?{receiptId:options.receiptId}:{})})};
}

function operation(operationId:OperationalRealityOperationId,repository:OperationalRealityProviderRepository):ProviderOperation {
  const schemas=OPERATIONAL_REALITY_SCHEMAS[operationId];
  const analysis=["correlation.resolve","predicate.evaluate","observability.evaluate"].includes(operationId);
  const descriptor:CapabilityDescriptor={
    operationId,operationVersion:"1.0",semanticRole:analysis?"DOMAIN_ANALYSIS":"PROJECTION_QUERY",
    dataBinding:"WORLD_SNAPSHOT_BOUND",resultSemantics:analysis?"DERIVED_ANALYSIS":"WORLD_PROJECTION",
    executionBindings:["SYNC_HTTP","VERSIONED_SQL_CONTRACT"],criticalPathPolicy:"REMOTE_ONLY",maturity:"PREVIEW",
    inputSchemaUri:schemas.inputSchemaUri,inputSchemaHash:schemas.inputSchemaHash,
    outputSchemaUri:schemas.outputSchemaUri,outputSchemaHash:schemas.outputSchemaHash,
    scopePolicy:"DATA_SCOPE_REQUIRED",execution:{mode:"SYNC",defaultTimeoutMs:10000,maximumTimeoutMs:30000,costClass:"MEDIUM"},
    limits:{maximumInputBytes:1048576,maximumOutputBytes:16777216,maximumRows:1000,maximumCandidates:5000},
    snapshotPolicy:{dataSnapshot:"REQUIRED",computeSnapshot:"REQUIRED"},
    ports:{inputs:[{name:"request",schemaUri:schemas.inputSchemaUri,schemaHash:schemas.inputSchemaHash,valueKind:"ANY",unitSemantics:"UNSPECIFIED"}],outputs:[{name:"result",schemaUri:schemas.outputSchemaUri,schemaHash:schemas.outputSchemaHash,valueKind:"ANY",unitSemantics:"UNSPECIFIED"}]}
  };
  return {descriptor,inputSchema:schemas.input,outputSchema:schemas.output,method:{
    engine:"PostgreSQL",engineVersion:"18",methodId:`gowm-operational-reality-v1/${operationId}`,methodVersion:"1.0",
    artifacts:[{kind:"DATABASE",name:"gowm_operational_reality_v1",version:"migration-032"}]
  },async handle(input,context){
    const scope=context.security.dataScopeClaim;
    if (!scope) throw new Error("authorized data scope is required");
    const result=await repository.execute(operationId,input,scope);
    return {status:result.status??"COMPLETED",...(result.output===undefined?{}:{value:result.output}),dataSnapshot:result.dataSnapshot,
      consumption:{rows:result.rows,candidates:result.candidates},warnings:result.warnings,changes:{repairApplied:false,typeChanged:false}};
  }};
}
