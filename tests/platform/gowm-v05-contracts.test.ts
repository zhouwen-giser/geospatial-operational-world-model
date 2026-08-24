import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  listContractSchemas,
  validateContract,
  type GowmV05RoutePlanningRequest,
  type GowmV05RoutePlanningResult
} from "../../packages/platform/contract-runtime/src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const contractRoot = join(repositoryRoot, "contracts/gowm-v0.5");

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(contractRoot, path), "utf8")) as unknown;
}

function canonicalRepositoryBytes(value: Buffer): Buffer {
  return Buffer.from(value.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}

describe("GOWM v0.5 network and routing contracts", () => {
  it("bundles all 19 schemas with unique stable v0.5 ids and generated types", async () => {
    const schemas = listContractSchemas().filter(({ key }) => key.startsWith("gowm-v0.5/"));
    expect(schemas).toHaveLength(19);
    expect(schemas.every(({ id }) => id?.startsWith("urn:gowm:v0.5:"))).toBe(true);
    expect(new Set(schemas.map(({ id }) => id))).toHaveLength(19);

    const request = await json("examples/route-with-waypoints.json") as GowmV05RoutePlanningRequest;
    const result = await json("examples/route-result-valid.json") as GowmV05RoutePlanningResult;
    expect(request.requestId).toBe("route-001");
    expect(result.revalidationRequired).toBe(true);
  });

  it("validates both provider manifests and every exact schema-file hash", async () => {
    for (const name of ["network-provider.json", "route-planning-provider.json"]) {
      const manifest = await json(`manifests/providers/${name}`) as {
        providerId: string;
        operations: Array<{
          operationId: string;
          maturity: string;
          inputSchemaFile: string;
          inputSchemaHash: string;
          outputSchemaFile: string;
          outputSchemaHash: string;
        }>;
      };
      expect(validateContract("urn:gowm:v0.5:provider-manifest-extension", manifest)).toEqual({ valid: true, issues: [] });
      for (const operation of manifest.operations) {
        for (const [schemaFile, lockedHash] of [
          [operation.inputSchemaFile, operation.inputSchemaHash],
          [operation.outputSchemaFile, operation.outputSchemaHash]
        ] as const) {
          const bytes = canonicalRepositoryBytes(await readFile(join(repositoryRoot, schemaFile)));
          expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, `${name}:${operation.operationId}:${basename(schemaFile)}`).toBe(lockedHash);
        }
      }
      expect(manifest.operations.some(({ operationId }) => operationId.includes("build") || operationId.includes("activate"))).toBe(false);
    }

    const routeManifest = await json("manifests/providers/route-planning-provider.json") as { operations: Array<{ operationId: string; maturity: string }> };
    expect(routeManifest.operations.find(({ operationId }) => operationId === "route.plan-alternatives")?.maturity).toBe("PREVIEW");
  });

  it("validates each contract-shaped example and preserves explicit expectation fixtures", async () => {
    for (const [name, schemaId] of [
      ["network-build-from-catalog.json", "urn:gowm:v0.5:network-build-request"],
      ["route-avoid-area.json", "urn:gowm:v0.5:route-planning-request"],
      ["route-result-valid.json", "urn:gowm:v0.5:route-planning-result"],
      ["route-with-waypoints.json", "urn:gowm:v0.5:route-planning-request"],
      ["shortest-turn-aware.json", "urn:gowm:v0.5:network-shortest-path-request"]
    ] as const) {
      expect(validateContract(schemaId, await json(`examples/${name}`)), name).toEqual({ valid: true, issues: [] });
    }

    const ambiguous = await json("examples/snap-ambiguous-parallel-road.json") as Record<string, unknown>;
    const { expectedStatus, ...snapRequest } = ambiguous;
    expect(expectedStatus).toBe("AMBIGUOUS");
    expect(validateContract("urn:gowm:v0.5:network-snap-request", snapRequest)).toEqual({ valid: true, issues: [] });

    expect(await json("examples/route-stale-condition.json")).toMatchObject({ expectedVerificationStatus: "STALE" });
    expect(await json("examples/gateway-route-dag.json")).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ operation: { id: "route.plan", version: "1.0" } }),
        expect.objectContaining({ operation: { id: "route.verify", version: "1.0" } })
      ])
    });
  });

  it("keeps every OpenAPI reference inside the frozen v0.5 contract tree", async () => {
    for (const name of await readdir(join(contractRoot, "openapi"))) {
      const document = await readFile(join(contractRoot, "openapi", name), "utf8");
      expect(document).toContain("openapi: 3.1.0");
      const references = [...document.matchAll(/\$ref:\s+\.\.\/([^\s]+)/gu)].map((match) => match[1]!);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        await expect(readFile(join(contractRoot, reference), "utf8"), `${name}:${reference}`).resolves.toContain("\"$schema\"");
      }
    }
  });
});
