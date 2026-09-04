import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { validatePayload, type SourceSchemaLock, type UgvAuthorityTopic } from "./contracts.js";

export interface SourceValidationResult {
  success: boolean;
  data?: unknown;
  errors: Array<Record<string,unknown>>;
}

/** Validates the immutable generated JSON Schema first, then adapter semantics. */
export class SourceSchemaRegistry {
  private readonly validators = new Map<UgvAuthorityTopic,ValidateFunction>();

  constructor(readonly lock: SourceSchemaLock) {
    const ajv = new Ajv({ allErrors: true,strict: false,validateFormats: false });
    for (const [name,schema] of Object.entries(lock.schemaDocuments)) ajv.addSchema(schema,name);
    for (const topic of lock.validatedTopics) {
      if (!isAuthorityTopic(topic)) throw new Error(`source lock contains an unsupported topic ${topic}`);
      this.validators.set(topic,ajv.compile(lock.topicSchemas[topic]));
    }
  }

  validate(topic: UgvAuthorityTopic,candidate: unknown): SourceValidationResult {
    const validate = this.validators.get(topic);
    if (!validate) return { success: false,errors: [{ code: "SOURCE_SCHEMA_MISSING",topic }] };
    if (!validate(candidate)) return { success: false,errors: sanitizeAjv(validate.errors) };
    const semantic = validatePayload(topic,candidate);
    return semantic.success ? { success: true,data: semantic.data,errors: [] }
      : { success: false,errors: semantic.errors.map((error) => ({ code: "ADAPTER_SEMANTIC_SCHEMA",detail: error })) };
  }
}

function sanitizeAjv(errors: ErrorObject[] | null | undefined): Array<Record<string,unknown>> {
  return (errors ?? []).map((error) => ({
    code: "SOURCE_MACHINE_SCHEMA",
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "machine schema validation failed"
  }));
}

function isAuthorityTopic(value: string): value is UgvAuthorityTopic {
  return value === "/ugv/gnss" || value === "/ugv/speed" || value === "status/ugv" ||
    value === "/ugv/mission_state" || value === "/ugv/area_recon/status" ||
    value === "/ugv/area_recon/targets" || value === "/ugv/area_recon/exception";
}
