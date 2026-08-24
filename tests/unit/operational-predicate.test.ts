import { describe,expect,it } from "vitest";
import {
  assertExternalPredicate,
  assertPredicateEvaluation
} from "../../packages/operational-model/src/events.js";

const reference = {
  namespace: "gowm" as const,kind: "WORLD_OBJECT" as const,
  id: "wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",version: "1"
};

describe("external predicate contracts",() => {
  it.each([
    "IS_INSIDE","IS_NEAR","INTERSECTS","HAS_REACHED",
    "HAS_STOPPED","HAS_OBSERVED","EVENT_OCCURRED","STATE_EQUALS"
  ])("accepts %s without treating it as an observation",(operator) => {
    expect(() => assertExternalPredicate({
      predicateId: `predicate-${operator}`,
      externalAuthority: "planner-test",subject: reference,operator,
      object: { id: "wrf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      parameters: { thresholdMeters: 10 }
    })).not.toThrow();
  });

  it("rejects undeclared predicate fields",() => {
    expect(() => assertExternalPredicate({
      predicateId: "predicate-invalid",externalAuthority: "planner-test",
      subject: reference,operator: "HAS_OBSERVED",assertedAsWorldFact: true
    })).toThrow();
  });

  it("accepts every conservative evaluation status",() => {
    for (const status of [
      "SUPPORTED","NOT_SUPPORTED","PARTIALLY_SUPPORTED",
      "INDETERMINATE","NO_DATA","CONFLICTING"
    ] as const) {
      expect(() => assertPredicateEvaluation({
        evaluationId: `pev-${status}`,predicateId: "predicate-1",status,
        evaluatedAtWorldVersion: 1,supportingEvidenceIds: [],
        contradictingEvidenceIds: [],assumptions: [],warnings: [],
        methodVersion: "predicate-evaluator-v1"
      })).not.toThrow();
    }
  });
});
