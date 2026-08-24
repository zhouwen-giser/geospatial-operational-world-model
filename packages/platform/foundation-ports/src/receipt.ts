import { randomUUID } from "node:crypto";
import {
  getContractSchemaHash,
  validateContract
} from "../../contract-runtime/src/index.js";
import { sha256 } from "./canonical-json.js";
import { FoundationPortError } from "./errors.js";
import type {
  Clock,
  FoundationExecution,
  IdFactory,
  OperationSchemaAttestation
} from "./types.js";

const PROVIDER_ID = "gowm.foundation-local";
const PROVIDER_VERSION = "0.2.0";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidIdFactory implements IdFactory {
  nextId(): string {
    return randomUUID();
  }
}

export interface ReceiptEngineAttestation {
  name: string;
  version: string;
  digest?: `sha256:${string}`;
}

export interface ReceiptMethod {
  methodId: string;
  methodVersion: string;
}

export interface ReceiptChanges {
  repairApplied: boolean;
  typeChanged: boolean;
  inputGeometryType?: string;
  outputGeometryType?: string;
}

export interface ReceiptArtifact {
  kind: "IMAGE" | "PACKAGE" | "GRID" | "DATABASE";
  name: string;
  version: string;
  digest?: `sha256:${string}`;
}

export interface ReceiptInput<T> {
  startedAt: Date;
  operationId: string;
  operationVersion: string;
  schemas: OperationSchemaAttestation;
  engine: ReceiptEngineAttestation;
  method: ReceiptMethod;
  policyVersion: string;
  policy: unknown;
  input: unknown;
  result: T;
  changes: ReceiptChanges;
  warnings?: string[];
  artifacts?: ReceiptArtifact[];
  implementationDigest?: `sha256:${string}`;
}

export class FoundationReceiptFactory {
  constructor(
    private readonly clock: Clock = new SystemClock(),
    private readonly ids: IdFactory = new UuidIdFactory()
  ) {}

  start(): Date {
    return this.clock.now();
  }

  complete<T>(input: ReceiptInput<T>): FoundationExecution<T> {
    assertDigest(input.schemas.inputSchemaHash, "input schema hash");
    assertDigest(input.schemas.outputSchemaHash, "output schema hash");
    assertSchemaAttestation(input.operationId, input.operationVersion, input.schemas);
    if (input.engine.digest !== undefined) assertDigest(input.engine.digest, "engine digest");
    if (input.implementationDigest !== undefined) {
      assertDigest(input.implementationDigest, "implementation digest");
    }
    for (const artifact of input.artifacts ?? []) {
      if (artifact.digest !== undefined) assertDigest(artifact.digest, `${artifact.kind} artifact digest`);
    }

    const completedAt = this.clock.now();
    const generatedAt = completedAt.toISOString();
    const durationMs = Math.max(0, completedAt.getTime() - input.startedAt.getTime());
    const computeSnapshot = {
      provider: {
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        ...(input.implementationDigest === undefined ? {} : { implementationDigest: input.implementationDigest })
      },
      operation: {
        operationId: input.operationId,
        operationVersion: input.operationVersion
      },
      engine: {
        name: input.engine.name,
        version: input.engine.version,
        ...(input.engine.digest === undefined ? {} : { digest: input.engine.digest })
      },
      policy: {
        version: input.policyVersion,
        digest: sha256({ version: input.policyVersion, configuration: input.policy })
      },
      schemas: {
        inputSchemaHash: input.schemas.inputSchemaHash,
        outputSchemaHash: input.schemas.outputSchemaHash
      },
      ...(input.artifacts === undefined || input.artifacts.length === 0
        ? {}
        : { artifacts: input.artifacts.map((artifact) => ({ ...artifact })) })
    };
    const receipt = {
      receiptId: `foundation:${input.operationId}:${input.operationVersion}:${this.ids.nextId()}`,
      operationId: input.operationId,
      operationVersion: input.operationVersion,
      providerId: PROVIDER_ID,
      providerVersion: PROVIDER_VERSION,
      inputHash: sha256(input.input),
      outputHash: sha256(input.result),
      computeSnapshotHash: sha256(computeSnapshot),
      generatedAt,
      durationMs,
      method: {
        engine: input.engine.name,
        engineVersion: input.engine.version,
        methodId: input.method.methodId,
        methodVersion: input.method.methodVersion
      },
      changes: { ...input.changes },
      warnings: [...(input.warnings ?? [])]
    };
    assertCanonicalContract("urn:gowm:v0.2:compute-snapshot-context", computeSnapshot);
    assertCanonicalContract("urn:gowm:v0.2:execution-receipt", receipt);
    return {
      result: input.result,
      computeSnapshot,
      receipt,
      supportingReceipts: [],
      executionContext: {
        executionBinding: "EMBEDDED_LOCAL",
        criticalPathPolicy: "LOCAL_ONLY",
        remoteDependency: false,
        evidenceSemantics: "COMPUTE_ONLY_NOT_WORLD_EVIDENCE"
      }
    };
  }
}

function assertSchemaAttestation(
  operationId: string,
  operationVersion: string,
  schemas: OperationSchemaAttestation
): void {
  let expectedInput: `sha256:${string}`;
  let expectedOutput: `sha256:${string}`;
  try {
    expectedInput = getContractSchemaHash(
      `urn:gowm:capability:${operationId}:input:${operationVersion}`
    );
    expectedOutput = getContractSchemaHash(
      `urn:gowm:capability:${operationId}:output:${operationVersion}`
    );
  } catch (error) {
    throw new FoundationPortError(
      "FOUNDATION_SCHEMA_HASH_MISMATCH",
      `No locked operation schemas are available for ${operationId}@${operationVersion}`,
      {
        stage: "SNAPSHOT",
        retryable: false,
        details: { operationId, operationVersion, fallbackApplied: false },
        cause: error
      }
    );
  }
  if (schemas.inputSchemaHash !== expectedInput || schemas.outputSchemaHash !== expectedOutput) {
    throw new FoundationPortError(
      "FOUNDATION_SCHEMA_HASH_MISMATCH",
      `Schema attestation drift detected for ${operationId}@${operationVersion}`,
      {
        stage: "SNAPSHOT",
        retryable: false,
        details: {
          operationId,
          operationVersion,
          expectedInputSchemaHash: expectedInput,
          actualInputSchemaHash: schemas.inputSchemaHash,
          expectedOutputSchemaHash: expectedOutput,
          actualOutputSchemaHash: schemas.outputSchemaHash,
          fallbackApplied: false
        }
      }
    );
  }
}

function assertCanonicalContract(nameOrId: string, value: unknown): void {
  const validation = validateContract(nameOrId, value);
  if (!validation.valid) {
    throw new FoundationPortError("FOUNDATION_RECEIPT_FAILURE", `${nameOrId} validation failed`, {
      stage: "RESULT_ASSEMBLY",
      retryable: false,
      details: {
        contract: nameOrId,
        issues: validation.issues
      }
    });
  }
}

function assertDigest(value: string, label: string): asserts value is `sha256:${string}` {
  if (!SHA256_PATTERN.test(value)) {
    throw new FoundationPortError("FOUNDATION_RECEIPT_FAILURE", `Invalid ${label}`, {
      stage: "RESULT_ASSEMBLY",
      retryable: false,
      details: { label }
    });
  }
}
