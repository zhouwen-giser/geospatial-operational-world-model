import { describe,expect,it } from "vitest";
import type pg from "pg";
import type { DataSnapshotContext } from "../../packages/platform/contract-runtime/src/index.js";
import { getContractSchemaHash } from "../../packages/platform/contract-runtime/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { createOperationalRealityProvider } from "../../services/providers/operational-reality-provider/src/provider.js";
import { OperationalRealityProviderRepository } from "../../services/providers/operational-reality-provider/src/repository.js";
import { loadControlledProviderDeployments } from "../../services/gateway/world-capability-gateway/src/config.js";

const pool={} as pg.Pool;

describe("operational reality provider",()=>{
  it("registers all frozen v0.4 operations with canonical hashes and policies",()=>{
    const provider=createOperationalRealityProvider({pool});
    expect(provider.runtime.manifest.provider.providerId).toBe("gowm.operational-reality");
    expect(provider.runtime.manifest.capabilities.map((item)=>item.operationId)).toEqual([
      "operational-task.find","operational-task.get","operational-task.get-timeline",
      "operational-task.find-by-correlation","world-event.find-by-correlation",
      "correlation.resolve","predicate.evaluate","observability.evaluate",
      "operational-task.get-execution-intervals"
    ]);
    for(const capability of provider.runtime.manifest.capabilities){
      expect(capability.scopePolicy).toBe("DATA_SCOPE_REQUIRED");
      expect(capability.criticalPathPolicy).toBe("REMOTE_ONLY");
      expect(capability.snapshotPolicy.dataSnapshot).toBe("REQUIRED");
      expect(capability.inputSchemaHash).toBe(getContractSchemaHash(capability.inputSchemaUri));
      expect(capability.outputSchemaHash).toBe(getContractSchemaHash(capability.outputSchemaUri));
    }
    expect(provider.runtime.manifest.capabilities.find((item)=>item.operationId==="correlation.resolve")?.ports.outputs)
      .toEqual(expect.arrayContaining([expect.objectContaining({name:"operationalTaskReferenceKey",path:"/operationalTaskReferenceKey",valueKind:"REFERENCE_KEY"})]));
    expect(provider.runtime.manifest.capabilities.find((item)=>item.operationId==="operational-task.get-execution-intervals")?.ports.outputs)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        name:"executionIntervalReferenceKey",
        path:"/intervals/0/executionIntervalReferenceKey",
        schemaUri:"urn:gowm:v0.7:reference-key",
        schemaHash:getContractSchemaHash("urn:gowm:v0.7:reference-key"),
        valueKind:"REFERENCE_KEY"
      })]));
    for(const operationId of ["predicate.evaluate","observability.evaluate"]){
      expect(provider.runtime.manifest.capabilities.find((item)=>item.operationId===operationId)?.ports.outputs)
        .toEqual(expect.arrayContaining([expect.objectContaining({name:"status",path:"/status",valueKind:"SCALAR"})]));
    }
  });
  it("remains controlled when the platform validation provider is registered",async()=>{
    const deployments=await loadControlledProviderDeployments("config/grounding-gateway-registry.json");
    const deployment=deployments.find((item)=>item.providerId==="gowm.operational-reality");
    expect(deployments).toHaveLength(5);
    expect(deployment?.approvedManifest).toEqual(createOperationalRealityProvider({pool}).runtime.manifest);
  });
  it("separates the delegated scope digest from the versioned operational evidence digest",async()=>{
    const evidenceDigest=`sha256:${"a".repeat(64)}` as const;
    const scopedPool={query:async()=>({rows:[{reference_key:"wrf_scope_opaque"}]})} as unknown as pg.Pool;
    const repository=new OperationalRealityProviderRepository(scopedPool,()=>new Date("2026-08-30T00:00:00Z"));
    const snapshot=await (repository as unknown as {
      snapshot(scope:string,read:{worldVersion:number;scopeDigest:string}):Promise<DataSnapshotContext>;
    }).snapshot("scope-a",{worldVersion:17,scopeDigest:evidenceDigest});

    expect(snapshot.scopeDigest).toBe(sha256({dataScopeKey:"scope-a"}));
    expect(snapshot.resources).toEqual([expect.objectContaining({
      referenceKey:{namespace:"gowm",kind:"DATA_SCOPE",id:"wrf_scope_opaque",version:"17"},
      digest:evidenceDigest
    })]);
  });
});
