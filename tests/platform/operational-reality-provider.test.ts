import { describe,expect,it } from "vitest";
import type pg from "pg";
import { getContractSchemaHash } from "../../packages/platform/contract-runtime/src/index.js";
import { createOperationalRealityProvider } from "../../services/providers/operational-reality-provider/src/provider.js";
import { loadControlledProviderDeployments } from "../../services/gateway/world-capability-gateway/src/config.js";

const pool={} as pg.Pool;

describe("operational reality provider",()=>{
  it("registers all frozen v0.4 operations with canonical hashes and policies",()=>{
    const provider=createOperationalRealityProvider({pool});
    expect(provider.runtime.manifest.provider.providerId).toBe("gowm.operational-reality");
    expect(provider.runtime.manifest.capabilities.map((item)=>item.operationId)).toEqual([
      "operational-task.find","operational-task.get","operational-task.get-timeline",
      "operational-task.find-by-correlation","world-event.find-by-correlation",
      "correlation.resolve","predicate.evaluate","observability.evaluate"
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
});
