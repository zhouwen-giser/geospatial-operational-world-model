import { isDeepStrictEqual } from "node:util";
import type {
  CapabilityResultEnvelope,
  ProviderExecutionRequest
} from "../../contract-runtime/src/index.js";
import {
  ProviderProtocolError,
  type ProviderErrorCode,
  type ProviderRuntime
} from "../../provider-sdk/src/index.js";

export interface ConformanceCase {
  runtime: ProviderRuntime;
  validRequest: ProviderExecutionRequest;
  differentInput: unknown;
  unknownFieldInput: unknown;
  deadlineRequest?: ProviderExecutionRequest;
}

export interface ConformanceCheck {
  name: string;
  status: "PASS" | "FAIL" | "NOT_RUN";
  detail?: string;
}

export interface ConformanceReport {
  providerId: string;
  operationId: string;
  operationVersion: string;
  checks: ConformanceCheck[];
  passed: boolean;
}

async function expectCode(action: () => Promise<unknown>, codes: readonly ProviderErrorCode[]): Promise<string | undefined> {
  try {
    await action();
    return `expected ${codes.join(" or ")} but execution succeeded`;
  } catch (error) {
    if (!(error instanceof ProviderProtocolError)) return `unexpected error type ${String(error)}`;
    return codes.includes(error.code) ? undefined : `expected ${codes.join(" or ")}, received ${error.code}`;
  }
}

export async function runProviderConformance(testCase: ConformanceCase): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const add = (name: string, failure?: string) => checks.push(failure ? { name, status: "FAIL", detail: failure } : { name, status: "PASS" });
  const request = structuredClone(testCase.validRequest);
  const descriptor = testCase.runtime.manifest.capabilities.find((candidate) =>
    candidate.operationId === request.operation.operationId &&
    candidate.operationVersion === request.operation.operationVersion
  );
  add("manifest-endpoint-operation-parity", descriptor ? undefined : "request operation is absent from manifest");

  let first: CapabilityResultEnvelope | undefined;
  try {
    first = await testCase.runtime.execute(request);
    add("valid-execution");
  } catch (error) {
    add("valid-execution", error instanceof Error ? error.message : String(error));
  }

  if (first) {
    add("result-envelope", first.computeSnapshot && first.receipts.length > 0 ? undefined : "compute snapshot or receipt missing");
    const worldIndependent = descriptor && ["WORLD_INDEPENDENT", "CALLER_DATA_BOUND"].includes(descriptor.dataBinding);
    add("receipt-evidence-separation", worldIndependent && (first.dataSnapshot !== undefined || first.evidenceReferences.length > 0)
      ? "world-independent result fabricated data snapshot/evidence"
      : undefined);
  } else {
    checks.push({ name: "result-envelope", status: "NOT_RUN", detail: "valid execution failed" });
    checks.push({ name: "receipt-evidence-separation", status: "NOT_RUN", detail: "valid execution failed" });
  }

  try {
    const replay = await testCase.runtime.execute(structuredClone(request));
    add("idempotent-replay", first && isDeepStrictEqual(first, replay) ? undefined : "replay result differs");
  } catch (error) {
    add("idempotent-replay", error instanceof Error ? error.message : String(error));
  }

  const conflict = structuredClone(request);
  conflict.input = testCase.differentInput;
  add("idempotency-conflict", await expectCode(() => testCase.runtime.execute(conflict), ["IDEMPOTENCY_CONFLICT"]));

  const wrongHash = structuredClone(request);
  wrongHash.idempotencyKey += "-wrong-hash";
  wrongHash.operation.inputSchemaHash = `sha256:${"0".repeat(64)}`;
  add("schema-hash-fail-closed", await expectCode(() => testCase.runtime.execute(wrongHash), ["SCHEMA_MISMATCH"]));

  const unknown = structuredClone(request);
  unknown.idempotencyKey += "-unknown-field";
  unknown.input = testCase.unknownFieldInput;
  add("unknown-input-fail-closed", await expectCode(() => testCase.runtime.execute(unknown), ["SCHEMA_MISMATCH", "INVALID_REQUEST"]));

  const outputBudget = structuredClone(request);
  outputBudget.idempotencyKey += "-output-budget";
  outputBudget.executionPolicy.maximumResultBytes = 1;
  add("output-budget", await expectCode(() => testCase.runtime.execute(outputBudget), ["BUDGET_EXCEEDED"]));

  if (testCase.deadlineRequest) {
    add("deadline", await expectCode(() => testCase.runtime.execute(structuredClone(testCase.deadlineRequest!)), ["DEADLINE_EXCEEDED"]));
  } else {
    checks.push({ name: "deadline", status: "NOT_RUN", detail: "no deadline case supplied" });
  }

  if (descriptor?.scopePolicy === "DATA_SCOPE_REQUIRED") {
    const noScope = structuredClone(request);
    noScope.idempotencyKey += "-no-scope";
    delete noScope.securityContext.dataScopeClaim;
    add("scope-policy", await expectCode(() => testCase.runtime.execute(noScope), ["SCOPE_REQUIRED"]));
  } else if (descriptor?.scopePolicy === "DATASET_SCOPE_REQUIRED") {
    const noScope = structuredClone(request);
    noScope.idempotencyKey += "-no-scope";
    delete noScope.securityContext.datasetScopeClaim;
    add("scope-policy", await expectCode(() => testCase.runtime.execute(noScope), ["SCOPE_REQUIRED"]));
  } else {
    checks.push({ name: "scope-policy", status: "PASS", detail: `policy ${descriptor?.scopePolicy ?? "unknown"} requires no data claim` });
  }

  return {
    providerId: testCase.runtime.manifest.provider.providerId,
    operationId: request.operation.operationId,
    operationVersion: request.operation.operationVersion,
    checks,
    passed: checks.every((check) => check.status === "PASS")
  };
}
