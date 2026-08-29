import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createRoutePlanningProvider } from "../../services/providers/route-planning-provider/src/provider.js";
import type { NetworkSqlPool } from "../../services/providers/network-provider/src/types.js";

const pool:NetworkSqlPool={async connect(){throw new Error("manifest test must not connect");}};
const canonicalSourceBytes=(path:string):Buffer=>Buffer.from(readFileSync(path,"utf8").replace(/\r\n/gu,"\n"),"utf8");
describe("gowm.route-planning provider",()=>{
  it("registers the frozen stable and preview operation locks",()=>{
    const provider=createRoutePlanningProvider({pool});
    const frozen=JSON.parse(readFileSync(resolve("contracts/gowm-v0.5/manifests/providers/route-planning-provider.json"),"utf8")) as {operations:Array<Record<string,string>>};
    expect(provider.runtime.manifest.provider.providerId).toBe("gowm.route-planning");
    expect(provider.runtime.manifest.capabilities.map((item)=>item.operationId)).toEqual(frozen.operations.map((item)=>item.operationId));
    expect(provider.runtime.manifest.capabilities.find((item)=>item.operationId==="route.plan-alternatives")?.maturity).toBe("PREVIEW");
    for(const [index,descriptor] of provider.runtime.manifest.capabilities.entries()){
      const lock=frozen.operations[index]!;expect(descriptor).toMatchObject({operationId:lock.operationId,operationVersion:lock.operationVersion,maturity:lock.maturity,inputSchemaHash:lock.inputSchemaHash,outputSchemaHash:lock.outputSchemaHash,scopePolicy:"DATA_SCOPE_REQUIRED"});
      for(const direction of ["input","output"] as const){const file=lock[`${direction}SchemaFile`]!;expect(lock[`${direction}SchemaHash`]).toBe(`sha256:${createHash("sha256").update(canonicalSourceBytes(resolve(file))).digest("hex")}`);}
    }
  });
});
