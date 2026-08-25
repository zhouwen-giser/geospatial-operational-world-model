import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  getContractSchema,
  isContractSchemaHash,
  validateContract,
  validateSchemaSet,
} from "../../packages/platform/contract-runtime/src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const contractRoot = resolve(repositoryRoot, "contracts/gowm-v0.6");
const readJson = <T = unknown>(path: string): T => JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8")) as T;
const example = (name: string) => readJson<{ schemaFile: string | null; value: unknown; expectedInvalid?: boolean }>(`contracts/gowm-v0.6/examples/${name}`);
const clone = <T>(value: T): T => structuredClone(value);
const rawSha256 = (path: string) =>
  `sha256:${createHash("sha256").update(readFileSync(resolve(repositoryRoot, path), "utf8").replaceAll("\r\n", "\n")).digest("hex")}`;

describe("GOWM v0.6 road coverage contracts", () => {
  it("bundles a resolvable authoritative schema set and generated types", () => {
    expect(validateSchemaSet()).toEqual({ valid: true, issues: [] });
    expect(getContractSchema("urn:gowm:v0.6:road-coverage-request").$id).toBe("urn:gowm:v0.6:road-coverage-request");
    const lock = readJson<{ schemaCount: number; schemas: Record<string, string> }>("reports/gowm-v0.6/a01-contract-lock.json");
    expect(Object.keys(lock.schemas)).toHaveLength(lock.schemaCount);
    for (const [name, digest] of Object.entries(lock.schemas)) {
      expect(rawSha256(`contracts/gowm-v0.6/${name}`)).toBe(`sha256:${digest}`);
    }
  });

  it("keeps every OpenAPI reference inside the authoritative v0.6 contract directory", () => {
    const openApiPath = resolve(contractRoot, "openapi/road-coverage-provider-v1.yaml");
    const openApi = readFileSync(openApiPath, "utf8");
    const references = [...openApi.matchAll(/\$ref:\s*([^\s}]+)/gu)].map((match) => match[1]!);
    expect(references).toHaveLength(9);
    for (const reference of references) expect(existsSync(resolve(dirname(openApiPath), reference))).toBe(true);
  });

  it("attests exactly five versioned Provider operations to raw schema bytes", () => {
    const manifest = readJson<{
      providerId: string;
      operations: Array<{
        operationId: string;
        operationVersion: string;
        inputSchemaFile: string;
        inputSchemaHash: string;
        outputSchemaFile: string;
        outputSchemaHash: string;
      }>;
    }>("contracts/gowm-v0.6/manifests/providers/road-coverage-provider.json");
    expect(validateContract("urn:gowm:v0.6:coverage-provider-manifest", manifest).valid).toBe(true);
    expect(manifest.providerId).toBe("gowm.road-coverage-planning");
    expect(manifest.operations.map(({ operationId }) => operationId)).toEqual([
      "coverage.road.validate",
      "coverage.road.select-obligations",
      "coverage.road.plan",
      "coverage.road.verify",
      "coverage.road.expand-geojson",
    ]);
    expect(new Set(manifest.operations.map(({ operationId, operationVersion }) => `${operationId}@${operationVersion}`)).size).toBe(5);
    for (const operation of manifest.operations) {
      expect(operation.operationVersion).toBe("1.0");
      expect(rawSha256(operation.inputSchemaFile)).toBe(operation.inputSchemaHash);
      expect(rawSha256(operation.outputSchemaFile)).toBe(operation.outputSchemaHash);
      const inputSchema = getContractSchema(`gowm-v0.6/${basename(operation.inputSchemaFile)}`);
      const outputSchema = getContractSchema(`gowm-v0.6/${basename(operation.outputSchemaFile)}`);
      expect(isContractSchemaHash(inputSchema.$id as string, operation.inputSchemaHash)).toBe(true);
      expect(isContractSchemaHash(outputSchema.$id as string, operation.outputSchemaHash)).toBe(true);
    }
  });

  it("validates every typed package example and rejects the intentional multi-route example", () => {
    for (const name of [
      "closed-clipped-both-directions.json",
      "expand-geojson-request.json",
      "full-edge-last-exit.json",
      "invalid-multi-route.json",
      "manual-fixed-obligation.json",
      "obligation-set.json",
      "open-fixed-end.json",
      "stale-verification.json",
      "verified-two-alternative-result.json",
    ]) {
      const fixture = example(name);
      const schemaName = `gowm-v0.6/${basename(fixture.schemaFile!)}`;
      expect(validateContract(schemaName, fixture.value).valid, name).toBe(!fixture.expectedInvalid);
    }
  });

  it("fails closed on unknown, multi-route, either-direction, and future fleet fields", () => {
    const request = example("closed-clipped-both-directions.json").value as Record<string, unknown>;
    for (const mutation of [
      (value: Record<string, unknown>) => { value.unknownField = true; },
      (value: Record<string, unknown>) => { value.routeCount = 2; },
      (value: Record<string, unknown>) => { (value.selectionPolicy as Record<string, unknown>).serviceMode = "EITHER_DIRECTION"; },
      (value: Record<string, unknown>) => { value.fleet = { vehicles: 2 }; },
    ]) {
      const invalid = clone(request);
      mutation(invalid);
      expect(validateContract("urn:gowm:v0.6:road-coverage-request", invalid).valid).toBe(false);
    }
  });

  it("accepts only canonical EPSG:4326 Polygon/MultiPolygon or an Area ReferenceKey", () => {
    const request = example("closed-clipped-both-directions.json").value as Record<string, unknown>;
    const referenceArea = clone(request);
    referenceArea.area = { namespace: "gowm", kind: "LAYER_FEATURE", id: "wrf_99999999999999999999999999999999", version: "1" };
    expect(validateContract("urn:gowm:v0.6:road-coverage-request", referenceArea).valid).toBe(true);

    const multiPolygon = clone(request);
    multiPolygon.area = { type: "MultiPolygon", coordinates: [((request.area as { coordinates: unknown }).coordinates)] };
    expect(validateContract("urn:gowm:v0.6:road-coverage-request", multiPolygon).valid).toBe(true);

    const line = clone(request);
    line.area = { type: "LineString", coordinates: [[112, 28], [113, 29]] };
    expect(validateContract("urn:gowm:v0.6:road-coverage-request", line).valid).toBe(false);

    const outOfRange = clone(request);
    (((outOfRange.area as { coordinates: number[][][] }).coordinates)[0]![0] as number[])[0] = 181;
    expect(validateContract("urn:gowm:v0.6:road-coverage-request", outOfRange).valid).toBe(false);

    const unclosed = clone(request);
    (((unclosed.area as { coordinates: number[][][] }).coordinates)[0]!.at(-1) as number[])[0] = 112.001;
    expect(validateContract("urn:gowm:v0.6:road-coverage-request", unclosed).valid).toBe(false);
  });

  it("freezes selection, service, endpoint, boundary, and alternative bounds", () => {
    const closed = example("closed-clipped-both-directions.json").value as Record<string, unknown>;
    const manual = example("manual-fixed-obligation.json").value;
    const open = example("open-fixed-end.json").value;
    const lastExit = example("full-edge-last-exit.json").value;
    expect(validateContract("urn:gowm:v0.6:road-coverage-request", manual).valid).toBe(true);
    expect(validateContract("urn:gowm:v0.6:road-coverage-request", open).valid).toBe(true);
    expect(validateContract("urn:gowm:v0.6:road-coverage-request", lastExit).valid).toBe(true);

    for (const mode of ["FULLY_COVERED_EDGE", "INTERSECTING_COMPLETE_EDGE", "CLIPPED_INSIDE_AREA"] as const) {
      const value = clone(closed);
      (value.selectionPolicy as Record<string, unknown>).mode = mode;
      expect(validateContract("urn:gowm:v0.6:road-coverage-request", value).valid, mode).toBe(true);
    }
    for (const boundary of ["FREE", "FIRST_ENTRY_ONLY", "ENTRY_SET_ONLY", "NO_REENTRY"] as const) {
      const value = clone(closed);
      (value.endpointPolicy as Record<string, unknown>).boundaryCrossingPolicy = boundary;
      expect(validateContract("urn:gowm:v0.6:road-coverage-request", value).valid, boundary).toBe(true);
    }
    for (const count of [0, 6]) {
      const value = clone(closed);
      (value.alternativePolicy as Record<string, unknown>).requestedCount = count;
      expect(validateContract("urn:gowm:v0.6:road-coverage-request", value).valid).toBe(false);
    }
  });

  it("requires revalidation and exposes no dispatchable result claim", () => {
    const result = example("verified-two-alternative-result.json").value as Record<string, unknown>;
    expect(validateContract("urn:gowm:v0.6:coverage-result-set", result).valid).toBe(true);
    const withoutRevalidation = clone(result);
    withoutRevalidation.revalidationRequired = false;
    expect(validateContract("urn:gowm:v0.6:coverage-result-set", withoutRevalidation).valid).toBe(false);
    const dispatchable = clone(result);
    dispatchable.dispatchable = true;
    expect(validateContract("urn:gowm:v0.6:coverage-result-set", dispatchable).valid).toBe(false);
    const wrongSetReference = clone(result);
    (wrongSetReference.referenceKey as Record<string, unknown>).kind = "DERIVED_REFERENCE";
    expect(validateContract("urn:gowm:v0.6:coverage-result-set", wrongSetReference).valid).toBe(false);
    const wrongAlternativeReference = clone(result);
    (((wrongAlternativeReference.alternatives as Array<Record<string, unknown>>)[0]!.referenceKey) as Record<string, unknown>).kind = "QUERY_RESULT";
    expect(validateContract("urn:gowm:v0.6:coverage-result-set", wrongAlternativeReference).valid).toBe(false);
  });
});
