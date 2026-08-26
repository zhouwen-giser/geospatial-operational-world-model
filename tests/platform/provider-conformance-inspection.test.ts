import { describe, expect, it } from "vitest";
import { schemaMatches, siblingImports } from "../../validation/scripts/provider-conformance-inspection.js";

describe("Provider conformance fail-closed inspection", () => {
  const canonical = `sha256:${"1".repeat(64)}`, sourceBytes = `sha256:${"2".repeat(64)}`, forged = `sha256:${"f".repeat(64)}`;
  const index = new Map([["urn:test:known", { canonical, sourceBytes }], ["contracts/known.schema.json", { canonical, sourceBytes }]]);
  it("compares hashes for URNs and file paths instead of accepting existence", () => {
    for (const uri of index.keys()) {
      expect(schemaMatches(uri, canonical, index)).toBe(true);
      expect(schemaMatches(uri, sourceBytes, index)).toBe(true);
      expect(schemaMatches(uri, forged, index)).toBe(false);
    }
  });
  it("rejects unknown URI/path and malformed or missing hash", () => {
    for (const uri of ["urn:test:unknown", "contracts/unknown.schema.json", "../../outside.schema.json", undefined]) {
      expect(schemaMatches(uri, canonical, index)).toBe(false);
    }
    for (const hash of [undefined, "", "sha256:wrong"]) expect(schemaMatches("urn:test:known", hash, index)).toBe(false);
  });
  it("detects sibling relative, absolute, re-export and dynamic imports without flagging owned imports", () => {
    const file = "/repo/services/providers/one/src/provider.ts";
    const source = `import { x } from '../../two/src/index.js';
      export { x } from '/repo/services/providers/three/src/index.js';
      const other = import('../../four/src/index.js');
      const old = require('../../five/src/index.js');
      import { own } from './repository.js';
      import { core } from '../../../../packages/core/index.js';`;
    expect(siblingImports(source, file, "/repo")).toHaveLength(4);
    expect(siblingImports(`import { own } from '../src/repository.js'`, file, "/repo")).toEqual([]);
  });
});
