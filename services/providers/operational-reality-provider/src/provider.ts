import semanticProfiles0 from "./semantic-profiles.operational.json" with { type: "json" };
import { declaredSemanticProfile } from "../../../../packages/platform/provider-sdk/src/declared-semantics.js";
const DECLARED_SEMANTICS = { ...semanticProfiles0 };
import type pg from "pg";
import type { CapabilityDescriptor,CapabilityProviderManifest } from "../../../../packages/platform/contract-runtime/src/index.js";
import { getContractSchemaHash } from "../../../../packages/platform/contract-runtime/src/index.js";
import { createProviderRuntime,ProviderProtocolError,sha256,type ProviderOperation,type ProviderRuntime } from "../../../../packages/platform/provider-sdk/src/index.js";
import { OperationalRealityProviderRepository } from "./repository.js";
import { OPERATIONAL_REALITY_OPERATION_IDS,OPERATIONAL_REALITY_SCHEMAS,type OperationalRealityOperationId } from "./schemas.js";

export interface OperationalRealityProvider { runtime:ProviderRuntime;repository:OperationalRealityProviderRepository; }
export function createOperationalRealityProvider(options:{pool:pg.Pool;now?:()=>Date;receiptId?:()=>string}):OperationalRealityProvider {
  const repository=new OperationalRealityProviderRepository(options.pool,options.now);
  const operations=OPERATIONAL_REALITY_OPERATION_IDS.map((id)=>operation(id,repository));
  const manifest:CapabilityProviderManifest={
    providerProtocolVersion:"1.0", manifestSchemaVersion: "1.1",provider:{
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
  const intervalProjection=operationId==="operational-task.get-execution-intervals";
  const descriptor:CapabilityDescriptor={
    operationId,operationVersion:"1.0", semanticProfile: declaredSemanticProfile(DECLARED_SEMANTICS, operationId, "1.0"),semanticRole:analysis?"DOMAIN_ANALYSIS":"PROJECTION_QUERY",
    dataBinding:"WORLD_SNAPSHOT_BOUND",resultSemantics:analysis?"DERIVED_ANALYSIS":"WORLD_PROJECTION",
    executionBindings:["SYNC_HTTP","VERSIONED_SQL_CONTRACT"],criticalPathPolicy:"REMOTE_ONLY",maturity:"PREVIEW",
    inputSchemaUri:schemas.inputSchemaUri,inputSchemaHash:schemas.inputSchemaHash,
    outputSchemaUri:schemas.outputSchemaUri,outputSchemaHash:schemas.outputSchemaHash,
    scopePolicy:"DATA_SCOPE_REQUIRED",execution:{mode:"SYNC",defaultTimeoutMs:10000,maximumTimeoutMs:30000,costClass:"MEDIUM"},
    limits:{maximumInputBytes:1048576,maximumOutputBytes:16777216,maximumRows:1000,maximumCandidates:5000},
    snapshotPolicy:{dataSnapshot:"REQUIRED",computeSnapshot:"REQUIRED",...(intervalProjection?{resourceResolution:"DISCOVER_RESOURCES" as const}:{})},
    ports:{
      inputs:[{name:"request",schemaUri:schemas.inputSchemaUri,schemaHash:schemas.inputSchemaHash,valueKind:"ANY",unitSemantics:"UNSPECIFIED"}],
      outputs:[
        {name:"result",schemaUri:schemas.outputSchemaUri,schemaHash:schemas.outputSchemaHash,valueKind:"ANY",unitSemantics:"UNSPECIFIED"},
        ...selectedOutputs(operationId)
      ]
    }
  };
  return {descriptor,inputSchema:schemas.input,outputSchema:schemas.output,method:{
    engine:"PostgreSQL",engineVersion:"18",methodId:`gowm-operational-reality-v1/${operationId}`,methodVersion:"1.0",
    artifacts:[
      {kind:"DATABASE",name:"gowm_operational_reality_v1",version:"migration-032"},
      ...(intervalProjection?[{kind:"DATABASE" as const,name:"gowm_history_v1",version:"migration-069"}]:[])
    ]
  },async handle(input,context){
    const scope=context.security.dataScopeClaim;
    if (!scope) throw new Error("authorized data scope is required");
    if (intervalProjection&&!context.snapshots.effective) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH","effective query snapshot is required for execution interval as-of selection");
    }
    const result=await repository.execute(operationId,input,scope,context.snapshots.effective,context.deadline.remainingMs());
    return {status:result.status??"COMPLETED",...(result.output===undefined?{}:{value:result.output}),dataSnapshot:result.dataSnapshot,
      ...(result.evidenceReferences===undefined?{}:{evidenceReferences:result.evidenceReferences}),
      consumption:{rows:result.rows,candidates:result.candidates},warnings:result.warnings,changes:{repairApplied:false,typeChanged:false}};
  }};
}

function selectedOutputs(operationId:OperationalRealityOperationId):CapabilityDescriptor["ports"]["outputs"] {
  if (operationId==="operational-task.get-execution-intervals") return [{
    name:"executionIntervalReferenceKey",path:"/intervals/0/executionIntervalReferenceKey",
    schemaUri:"urn:gowm:v0.7:reference-key",schemaHash:getContractSchemaHash("urn:gowm:v0.7:reference-key"),
    valueKind:"REFERENCE_KEY",unitSemantics:"UNSPECIFIED"
  }];
  if (operationId==="correlation.resolve") return [{
    name:"operationalTaskReferenceKey",path:"/operationalTaskReferenceKey",
    schemaUri:"urn:gowm:v0.4:reference-key",schemaHash:getContractSchemaHash("urn:gowm:v0.4:reference-key"),
    valueKind:"REFERENCE_KEY",unitSemantics:"UNSPECIFIED"
  }];
  if (operationId==="predicate.evaluate"||operationId==="observability.evaluate") return [{
    name:"status",path:"/status",schemaUri:"urn:gowm:v0.2:value:string",
    schemaHash:getContractSchemaHash("urn:gowm:v0.2:value:string"),valueKind:"SCALAR",unitSemantics:"UNSPECIFIED"
  }];
  return [];
}
