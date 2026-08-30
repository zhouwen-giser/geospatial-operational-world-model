import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../packages/platform/contract-runtime/src/index.js";
import {
  normalizedNonDisclosureResponse,
  submittedReferenceIdentifiers
} from "../../scripts/sample-world/verify.js";

const hidden = {
  namespace: "gowm",
  kind: "LAYER_FEATURE",
  id: "wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  version: "7"
};
const absent = {
  namespace: "gowm",
  kind: "LAYER_FEATURE",
  id: "wrf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  version: "7"
};

describe("sample-world governed non-disclosure projection", () => {
  it("redacts only the submitted reference echo and removes request-specific noise", () => {
    const hiddenBody = {
      status: "COMPLETED",
      requestId: "hidden-request",
      output: { value: { results: [{ referenceKey: hidden, status: "NOT_FOUND" }] } },
      receipts: [{ receiptId: "hidden-receipt", inputHash: "hidden", durationMs: 7 }]
    };
    const absentBody = {
      status: "COMPLETED",
      requestId: "control-request",
      output: { value: { results: [{ referenceKey: absent, status: "NOT_FOUND" }] } },
      receipts: [{ receiptId: "control-receipt", inputHash: "control", durationMs: 11 }]
    };
    expect(canonicalSha256(normalizedNonDisclosureResponse(hiddenBody, { referenceKey: hidden })))
      .toBe(canonicalSha256(normalizedNonDisclosureResponse(absentBody, { referenceKey: absent })));
  });

  it("retains a hidden identifier leaked outside the submitted-reference echo", () => {
    const projected = normalizedNonDisclosureResponse({
      error: { code: "NOT_FOUND", details: { leakedId: hidden.id } }
    }, { referenceKey: hidden });
    expect(JSON.stringify(projected)).toContain(hidden.id);
    expect(submittedReferenceIdentifiers({ referenceKey: hidden })).toEqual([hidden.id]);
  });
});
