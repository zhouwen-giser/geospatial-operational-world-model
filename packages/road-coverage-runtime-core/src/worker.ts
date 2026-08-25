import type { CoverageAsyncRepository, CoverageClaim } from "./async-repository.js";

export interface CoverageWorkerProduct {
  problemHash: `sha256:${string}`;
  canonicalProblem: Record<string, unknown>;
  result: {
    referenceKey: string;
    status: "SUCCEEDED" | "PARTIAL" | "NO_FEASIBLE_PLAN";
    resultHash: `sha256:${string}`;
    validUntil: string;
    record: Record<string, unknown>;
  };
}

/** Each repository call is one bounded statement; compute never holds a DB client or transaction. */
export async function executeCoverageWorkerOnce(
  repository: CoverageAsyncRepository,
  input: { attempt: number; leaseOwner: string; leaseSeconds: number; maximumScopeConcurrency: number },
  compute: (claim: CoverageClaim) => Promise<CoverageWorkerProduct>
): Promise<"IDLE" | "PUBLISHED"> {
  const claim = await repository.claimNext(input.attempt, input.leaseOwner, input.leaseSeconds, input.maximumScopeConcurrency);
  if (claim === null) return "IDLE";
  if (!await repository.heartbeat(claim, input.leaseOwner, input.leaseSeconds, "BUILDING", 100_000, {})) throw new Error("coverage worker lost its lease before compute");
  const product = await compute(claim);
  await repository.persistProblem(claim, input.leaseOwner, product.problemHash, product.canonicalProblem);
  if (!await repository.heartbeat(claim, input.leaseOwner, input.leaseSeconds, "PUBLISHING", 900_000, {})) throw new Error("coverage worker lost its lease before publish");
  const published = await repository.publishResult(claim, input.leaseOwner, {
    referenceKey: product.result.referenceKey,
    status: product.result.status,
    resultHash: product.result.resultHash,
    validUntil: product.result.validUntil,
    result: product.result.record
  });
  if (!published) throw new Error("coverage worker result was not published");
  return "PUBLISHED";
}
