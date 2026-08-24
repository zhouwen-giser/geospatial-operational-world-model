import type {
  CapabilityResultEnvelope,
  ExecutionReceipt,
  JobRecord
} from "../../../../packages/platform/contract-runtime/src/index.js";

export interface GatewayRecordStore {
  putResult(result: CapabilityResultEnvelope): Promise<void>;
  getReceipt(receiptId: string): Promise<ExecutionReceipt | undefined>;
  getJob(jobId: string): Promise<JobRecord | undefined>;
}

export class MemoryGatewayRecordStore implements GatewayRecordStore {
  readonly #receipts = new Map<string, ExecutionReceipt>();
  readonly #jobs = new Map<string, JobRecord>();

  async putResult(result: CapabilityResultEnvelope): Promise<void> {
    for (const receipt of result.receipts) this.#receipts.set(receipt.receiptId, structuredClone(receipt));
  }

  async putJob(job: JobRecord): Promise<void> {
    this.#jobs.set(job.jobId, structuredClone(job));
  }

  async getReceipt(receiptId: string): Promise<ExecutionReceipt | undefined> {
    const receipt = this.#receipts.get(receiptId);
    return receipt === undefined ? undefined : structuredClone(receipt);
  }

  async getJob(jobId: string): Promise<JobRecord | undefined> {
    const job = this.#jobs.get(jobId);
    return job === undefined ? undefined : structuredClone(job);
  }
}
