import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { validateContract, type ProviderExecutionRequest } from "../../packages/platform/contract-runtime/src/index.js";
import { sha256, type ProviderOperationResult } from "../../packages/platform/provider-sdk/src/index.js";
import { createRoadCoverageProvider, ROAD_COVERAGE_OPERATION_LOCKS } from "../../services/providers/road-coverage-provider/src/provider.js";
import type { RoadCoverageEngine } from "../../services/providers/road-coverage-provider/src/provider.js";
import { resolveCoverageArea } from "../../services/providers/road-coverage-provider/src/area-reference.js";

function unused(): Promise<ProviderOperationResult<unknown>> {
  throw new Error("operation should not execute in this protocol test");
}

const engine: RoadCoverageEngine = {
  validate: unused,
  selectObligations: unused,
  plan: unused,
  verify: unused,
  expandGeoJson: unused
};

describe("road coverage Provider protocol", () => {
  it("resolves a pinned scoped area without mutating the caller or dropping its provenance", async () => {
    const key = {namespace:"gowm",kind:"LAYER_FEATURE",id:`wrf_${"1".repeat(32)}`,version:"descriptor-v1"};
    const geometry = {type:"Polygon",coordinates:[[[0,0],[1,0],[1,1],[0,0]]]};
    const calls:string[] = [];
    const pool = {async connect() { return {async query(sql:string,values?:unknown[]) {
      calls.push(sql);
      if(sql.includes("set_scope")) expect(values).toEqual(["scope-a","dataset-a"]);
      if(sql.includes("coverage_area_reference")) { expect(values).toEqual([key.id,key.version]); return {rows:[{geometry,feature_version:"feature-v1",content_hash:`sha256:${"f".repeat(64)}`}]}; }
      return {rows:[]};
    },release(){calls.push("release");}};}};
    const context = {security:{dataScopeClaim:"scope-a",datasetScopeClaims:["dataset-a"]},deadline:{remainingMs:()=>1000}};
    const original = {area:key};
    const resolved = await resolveCoverageArea(pool as never,original as never,context as never);
    expect(original.area).toEqual(key);
    expect(resolved.request.area).toEqual(geometry);
    expect(resolved.resource).toMatchObject({referenceKey:{...key,version:"feature-v1"},pinning:"PINNED"});
    expect(calls[0]).toContain("READ ONLY"); expect(calls.at(-2)).toBe("COMMIT"); expect(calls.at(-1)).toBe("release");
    await expect(resolveCoverageArea(pool as never,{area:{...key,kind:"WORLD_OBJECT"}} as never,context as never)).rejects.toThrow("LAYER_FEATURE");
  });
  it("fails closed for absent or ambiguous area versions and rolls back", async () => {
    for (const count of [0,2]) {
      const calls:string[]=[];
      const pool={async connect(){return {async query(sql:string){calls.push(sql);return {rows:sql.includes("coverage_area_reference")?Array.from({length:count},()=>({})):[]};},release(){calls.push("release");}};}};
      await expect(resolveCoverageArea(pool as never,{area:{namespace:"gowm",kind:"LAYER_FEATURE",id:"missing",version:"v1"}} as never,{security:{dataScopeClaim:"a",datasetScopeClaims:["b"]},deadline:{remainingMs:()=>100}} as never)).rejects.toThrow("unavailable or ambiguous");
      expect(calls.slice(-2)).toEqual(["ROLLBACK","release"]);
    }
  });
  it("registers the exact five frozen operation and schema locks", () => {
    const manifest = createRoadCoverageProvider(engine).runtime.manifest;
    expect(validateContract("capability-provider-manifest.schema.json", manifest)).toMatchObject({ valid: true });
    expect(manifest.provider.providerId).toBe("gowm.road-coverage-planning");
    expect(manifest.capabilities.map((capability) => ({
      operationId: capability.operationId,
      mode: capability.execution.mode,
      maturity: capability.maturity,
      inputSchemaHash: capability.inputSchemaHash,
      outputSchemaHash: capability.outputSchemaHash
    }))).toEqual(ROAD_COVERAGE_OPERATION_LOCKS.map((lock) => ({
      operationId: lock.operationId,
      mode: lock.executionMode,
      maturity: "STABLE",
      inputSchemaHash: lock.inputSchemaHash,
      outputSchemaHash: lock.outputSchemaHash
    })));
    for (const lock of ROAD_COVERAGE_OPERATION_LOCKS) {
      for (const [uri, expected] of [[lock.inputSchemaUri, lock.inputSchemaHash], [lock.outputSchemaUri, lock.outputSchemaHash]] as const) {
        const name = uri.slice(uri.lastIndexOf(":") + 1);
        const actual = `sha256:${createHash("sha256").update(readFileSync(resolve(`contracts/gowm-v0.6/${name}.schema.json`))).digest("hex")}`;
        expect(actual).toBe(expected);
      }
    }
  });

  it("pins plan to the Gateway async binding while retaining synchronous protocol operations", () => {
    const manifest = createRoadCoverageProvider(engine).runtime.manifest;
    const byId = new Map(manifest.capabilities.map((capability) => [capability.operationId, capability]));
    expect(byId.get("coverage.road.plan")?.execution).toMatchObject({ mode: "ASYNC" });
    expect(byId.get("coverage.road.plan")?.executionBindings).toContain("ASYNC_JOB");
    expect(byId.get("coverage.road.verify")?.execution.mode).toBe("SYNC_OR_ASYNC");
    for (const operationId of ["coverage.road.validate", "coverage.road.select-obligations", "coverage.road.expand-geojson"]) {
      expect(byId.get(operationId)?.execution.mode).toBe("SYNC");
    }
  });

  it("requires scope and snapshots and exposes no second algorithm or job authority", () => {
    const manifest = createRoadCoverageProvider(engine).runtime.manifest;
    for (const capability of manifest.capabilities) {
      expect(capability.scopePolicy).toBe("DATA_SCOPE_REQUIRED");
      expect(capability.dataBinding).toBe("WORLD_SNAPSHOT_BOUND");
      expect(capability.snapshotPolicy).toEqual({ dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" });
      expect(capability.executionBindings).not.toContain("EMBEDDED_SDK");
    }
    expect(JSON.stringify(manifest)).not.toMatch(/gowm\.network|gowm\.route-planning|WSGS|SACS|SDAR|SMPP|A2A/u);
    expect(manifest.endpoints.job).toBe("/v1/jobs/{jobId}");
  });

  it("executes the frozen validate contract with receipts and evidence kept outside output", async () => {
    const fixture = JSON.parse(readFileSync(resolve("contracts/gowm-v0.6/examples/closed-clipped-both-directions.json"), "utf8")) as { value: unknown };
    const request = fixture.value;
    const validationEngine: RoadCoverageEngine = {
      ...engine,
      async validate() {
        return {
          status: "COMPLETED",
          value: {
            schemaVersion: "1.0",
            valid: true,
            violations: [],
            warnings: [],
            normalizedSummary: {
              routeCount: 1,
              selectionMode: "CLIPPED_INSIDE_AREA",
              serviceMode: "BOTH_DIRECTIONS",
              endpointMode: "RETURN_TO_START",
              requestedAlternativeCount: 2
            }
          },
          dataSnapshot: {
            consistency: "PINNED",
            capturedAt: "2026-08-25T03:00:00.000Z",
            scopeDigest: `sha256:${"a".repeat(64)}`,
            resources: [{
              authority: "gowm_network_v1",
              pinning: "PINNED",
              referenceKey: { namespace: "gowm", kind: "DATASET", id: `wrf_${"1".repeat(32)}`, version: "graph-v1" }
            }]
          },
          evidenceReferences: [],
          consumption: { rows: 1, candidates: 0 },
          warnings: [],
          changes: { repairApplied: false, typeChanged: false }
        };
      }
    };
    const runtime = createRoadCoverageProvider(validationEngine).runtime;
    const descriptor = runtime.manifest.capabilities.find(({ operationId }) => operationId === "coverage.road.validate");
    if (descriptor === undefined) throw new Error("validate operation missing");
    const deadlineAt = new Date(Date.now() + 10_000).toISOString();
    const providerRequest: ProviderExecutionRequest = {
      providerProtocolVersion: "1.0",
      requestId: "coverage-provider-request-1",
      gatewayRequestId: "coverage-gateway-request-1",
      idempotencyKey: "coverage-provider-idempotency-1",
      operation: {
        operationId: descriptor.operationId,
        operationVersion: descriptor.operationVersion,
        inputSchemaHash: descriptor.inputSchemaHash,
        outputSchemaHash: descriptor.outputSchemaHash
      },
      input: request,
      securityContext: {
        principalRef: "principal:coverage-test",
        authenticationMethod: "TEST_ATTESTED",
        authenticatedAt: new Date().toISOString(),
        dataScopeClaim: "coverage-provider-test",
        datasetScopeClaim: "dataset-a",
        scopeAttestation: {
          issuer: "gateway-test",
          issuedAt: new Date().toISOString(),
          expiresAt: deadlineAt,
          claimDigest: sha256({ dataScopeKey: "coverage-provider-test", datasetScopeKey: "dataset-a" })
        }
      },
      gatewayContext: { gatewayId: "gateway-test", registryVersion: "registry-1", policyVersion: "policy-1" },
      executionPolicy: {
        deadlineAt,
        maximumInputBytes: 1_048_576,
        maximumResultBytes: 1_048_576,
        maximumCostClass: "MEDIUM"
      }
    };
    const result = await runtime.execute(providerRequest);
    expect(validateContract("capability-result-envelope.schema.json", result)).toMatchObject({ valid: true });
    expect(result.output?.value).toMatchObject({ schemaVersion: "1.0", valid: true });
    expect(result.dataSnapshot?.resources[0]?.authority).toBe("gowm_network_v1");
    expect(result.computeSnapshot.schemas).toEqual({ inputSchemaHash: descriptor.inputSchemaHash, outputSchemaHash: descriptor.outputSchemaHash });
    expect(result.receipts).toHaveLength(1);
    expect(result.evidenceReferences).toEqual([]);
    expect(result.output?.value).not.toHaveProperty("receipts");
    expect(result.output?.value).not.toHaveProperty("evidenceReferences");
  });
});
