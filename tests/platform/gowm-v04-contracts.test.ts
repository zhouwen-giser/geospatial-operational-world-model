import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getContractSchemaHash,
  listContractSchemas,
  validateContract
} from "../../packages/platform/contract-runtime/src/index.js";

const contractRoot = resolve("contracts/gowm-v0.4");

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(contractRoot, path), "utf8")) as unknown;
}

describe("GOWM v0.3/v0.4 authority contracts", () => {
  it("bundles all 27 authoritative schemas with their stable ids", () => {
    const schemas = listContractSchemas().filter(({ key }) => key.startsWith("gowm-v0.4/"));
    expect(schemas).toHaveLength(27);
    expect(schemas.every(({ id }) => id?.startsWith("urn:gowm:v0.4:"))).toBe(true);
    expect(new Set(schemas.map(({ id }) => id)).size).toBe(27);
  });

  it("validates every extension Provider manifest and its exact schema hashes", async () => {
    for (const name of [
      "reference-catalog-provider.json",
      "dataset-catalog-provider.json",
      "world-evidence-provider.json",
      "operational-reality-provider.json"
    ]) {
      const manifest = await json(`manifests/providers/${name}`) as {
        operations: Array<{
          inputSchemaFile: string;
          inputSchemaHash: string;
          outputSchemaFile: string;
          outputSchemaHash: string;
        }>;
      };
      expect(validateContract("urn:gowm:v0.4:extension-provider-manifest", manifest)).toEqual({ valid: true, issues: [] });
      for (const operation of manifest.operations) {
        for (const [schemaFile, lockedHash] of [
          [operation.inputSchemaFile, operation.inputSchemaHash],
          [operation.outputSchemaFile, operation.outputSchemaHash]
        ] as const) {
          const name = basename(schemaFile);
          const bytes = await readFile(resolve(contractRoot, name));
          expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(lockedHash);
          expect(getContractSchemaHash(name)).toMatch(/^sha256:[0-9a-f]{64}$/u);
        }
      }
    }
  });

  it.each([
    ["correlation-exact.json", "urn:gowm:v0.4:correlation-finding"],
    ["derived-buffer-reference.json", "urn:gowm:v0.4:derived-reference"],
    ["operational-completed-unverified.json", "urn:gowm:v0.4:operational-task-snapshot"],
    ["operational-event-timeline.json", "urn:gowm:v0.4:operational-event-timeline"],
    ["predicate-no-data.json", "urn:gowm:v0.4:predicate-evaluation"]
  ])("validates canonical example %s", async (name, schemaId) => {
    expect(validateContract(schemaId, await json(`examples/${name}`))).toEqual({ valid: true, issues: [] });
  });

  it("keeps ReferenceKey opaque and the four operational state dimensions independent", async () => {
    const common = await json("common.schema.json") as {
      $defs: { referenceKey: { properties: { id: { pattern: string } } } };
    };
    expect(common.$defs.referenceKey.properties.id.pattern).toBe("^wrf_[0-9a-f]{32}$");

    const snapshot = await json("operational-task-snapshot.schema.json") as {
      required: string[];
      properties: Record<string, unknown>;
    };
    for (const dimension of ["controlState", "activityState", "outcomeVerification", "observability"]) {
      expect(snapshot.required).toContain(dimension);
      expect(snapshot.properties).toHaveProperty(dimension);
    }
  });
});
