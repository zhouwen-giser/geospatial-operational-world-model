import { describe, expect, it } from "vitest";
import {
  isCurrentBlackBoxReceipt,
  operationEvidenceDigest,
  type OperationEvidenceRecord
} from "../../scripts/materialize-capability-semantic-profiles.js";

const records: OperationEvidenceRecord[] = [
  { kind: "DESCRIPTOR", path: "contracts\\provider.json", sha256: "descriptor" },
  { kind: "INPUT_SCHEMA", path: "contracts/input.schema.json", sha256: "input" },
  { kind: "TYPESCRIPT_IMPLEMENTATION", path: "services/provider.ts", sha256: "implementation", symbol: "execute" },
  { kind: "UNIT_TEST", path: "tests/provider.test.ts", sha256: "test" },
  { kind: "SQL_IMPLEMENTATION", path: "database/read.sql", sha256: "sql" }
];

const receipt = (evidenceDigest?: string) => ({
  status: "PASS",
  sourceDigest: "sha256:run",
  contractHash: "sha256:contract",
  ...(evidenceDigest ? { evidenceDigest } : {}),
  tests: ["real-canary"]
});

const current = (overrides: Partial<Parameters<typeof isCurrentBlackBoxReceipt>[0]> = {}) => {
  const evidenceDigest = operationEvidenceDigest(records);
  return isCurrentBlackBoxReceipt({
    reportStatus: "PASS",
    reportSourceDigest: "sha256:run",
    receipt: receipt(evidenceDigest),
    contractHash: "sha256:contract",
    evidenceDigest,
    ...overrides
  });
};

describe("operation-scoped black-box freshness", () => {
  it("canonicalizes record order and Windows paths", () => {
    const normalized = records.map((record) => ({ ...record, path: record.path.replaceAll("\\", "/") })).reverse();
    expect(operationEvidenceDigest(records)).toBe(operationEvidenceDigest(normalized));
  });

  it.each(["TYPESCRIPT_IMPLEMENTATION", "UNIT_TEST", "SQL_IMPLEMENTATION"])(
    "expires a receipt when %s evidence bytes change",
    (kind) => {
      const changed = records.map((record) => record.kind === kind ? { ...record, sha256: `${record.sha256}-changed` } : record);
      expect(current({ evidenceDigest: operationEvidenceDigest(changed) })).toBe(false);
    }
  );

  it("does not expire an unrelated operation digest", () => {
    const unrelated = [{ kind: "UNIT_TEST", path: "tests/unrelated.test.ts", sha256: "unrelated" }];
    const before = operationEvidenceDigest(unrelated);
    const changed = records.map((record, index) => index === 2 ? { ...record, sha256: "implementation-changed-again" } : record);
    expect(operationEvidenceDigest(changed)).not.toBe(operationEvidenceDigest(records));
    expect(operationEvidenceDigest(unrelated)).toBe(before);
  });

  it("migrates a legacy receipt only from an exact prior PROVEN non-black-box digest", () => {
    const evidenceDigest = operationEvidenceDigest(records);
    const legacyEvidence = [...records, { kind: "BLACK_BOX_TEST", path: "reports/black-box.json", sha256: "old-run" }];
    expect(current({ receipt: receipt(), evidenceDigest, legacyAttestation: { status: "PROVEN", evidence: legacyEvidence } })).toBe(true);
    expect(current({ receipt: receipt(), evidenceDigest, legacyAttestation: { status: "BLOCKED", evidence: legacyEvidence } })).toBe(false);
    expect(current({ receipt: receipt(), evidenceDigest: operationEvidenceDigest([...records, { kind: "UNIT_TEST", path: "tests/new.test.ts", sha256: "new" }]), legacyAttestation: { status: "PROVEN", evidence: legacyEvidence } })).toBe(false);
  });
});
