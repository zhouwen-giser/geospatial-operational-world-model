import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { JsonSchema } from "../../../../packages/platform/contract-runtime/src/index.js";
import { sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";

type Sha256Digest = `sha256:${string}`;

interface CanonicalSchemaLockEntry {
  schemaUri: string;
  schemaHash: Sha256Digest;
  schemaPath: string;
}

interface CanonicalSchemaLockDocument {
  schemaVersion: "gowm-canonical-schema-lock/1.0";
  lockId: string;
  providerId: string;
  schemas: CanonicalSchemaLockEntry[];
  supportingSchemas: CanonicalSchemaLockEntry[];
}

export interface OperatorCanonicalSchema {
  schemaHash: Sha256Digest;
  schema: JsonSchema;
}

export interface CanonicalSchemaLock {
  schemaHashes: ReadonlyMap<string, Sha256Digest>;
  schemas: ReadonlyMap<string, OperatorCanonicalSchema>;
  documents: Readonly<Record<string, JsonSchema>>;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SCHEMA_URI_PATTERN = /^urn:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SCHEMA_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const MAX_SCHEMA_LOCK_ENTRIES = 2_048;
const MAX_SCHEMA_DOCUMENTS = 4_096;

export function loadCanonicalSchemaLock(
  schemaLockPath: string | undefined,
  schemaRootPath?: string
): CanonicalSchemaLock {
  if (schemaLockPath === undefined) return { schemaHashes: new Map(), schemas: new Map(), documents: {} };
  const document = JSON.parse(readFileSync(schemaLockPath, "utf8")) as unknown;
  assertDocument(document);
  const root = resolve(schemaRootPath ?? dirname(schemaLockPath));
  const schemaHashes = new Map<string, Sha256Digest>();
  const schemas = new Map<string, OperatorCanonicalSchema>();
  const documents: Record<string, JsonSchema> = {};
  const seen = new Set<string>();
  for (const entry of document.schemas) {
    const schema = loadSchema(root, entry, seen);
    schemaHashes.set(entry.schemaUri, entry.schemaHash);
    schemas.set(entry.schemaUri, { schemaHash: entry.schemaHash, schema });
    documents[entry.schemaUri] = schema;
  }
  for (const entry of document.supportingSchemas) {
    const schema = loadSchema(root, entry, seen);
    documents[entry.schemaUri] = schema;
  }
  return { schemaHashes, schemas, documents };
}

function loadSchema(root: string, entry: CanonicalSchemaLockEntry, seen: Set<string>): JsonSchema {
  if (seen.has(entry.schemaUri)) throw new Error(`Canonical schema lock contains duplicate URI: ${entry.schemaUri}`);
  seen.add(entry.schemaUri);
  const path = resolveSchemaPath(root, entry.schemaPath);
  const schema = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(schema) || schema.$id !== entry.schemaUri) {
    throw new Error(`Canonical schema document $id differs for ${entry.schemaUri}`);
  }
  const actualHash = sha256(schema);
  if (actualHash !== entry.schemaHash) {
    throw new Error(`Canonical schema document hash differs for ${entry.schemaUri}`);
  }
  return schema;
}

function resolveSchemaPath(root: string, schemaPath: string): string {
  const segments = schemaPath.split("/");
  if (
    !SCHEMA_PATH_PATTERN.test(schemaPath) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Canonical schema lock contains an invalid relative schemaPath");
  }
  const path = resolve(root, ...segments);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Canonical schema lock schemaPath escapes the configured schema root");
  }
  return path;
}

function assertDocument(value: unknown): asserts value is CanonicalSchemaLockDocument {
  if (!isRecord(value)) throw new Error("Canonical schema lock must be a JSON object");
  if (value.schemaVersion !== "gowm-canonical-schema-lock/1.0") {
    throw new Error("Canonical schema lock has an unsupported schemaVersion");
  }
  for (const field of ["lockId", "providerId"] as const) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new Error(`Canonical schema lock ${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(value.schemas) || value.schemas.length < 1 || value.schemas.length > MAX_SCHEMA_LOCK_ENTRIES) {
    throw new Error(`Canonical schema lock schemas must contain 1..${MAX_SCHEMA_LOCK_ENTRIES} entries`);
  }
  if (
    !Array.isArray(value.supportingSchemas) ||
    value.supportingSchemas.length > MAX_SCHEMA_LOCK_ENTRIES ||
    value.schemas.length + value.supportingSchemas.length > MAX_SCHEMA_DOCUMENTS
  ) {
    throw new Error(`Canonical schema lock supportingSchemas exceeds the ${MAX_SCHEMA_DOCUMENTS} document limit`);
  }
  for (const [index, entry] of [...value.schemas, ...value.supportingSchemas].entries()) {
    if (!isRecord(entry)) throw new Error(`Canonical schema lock entry ${index} must be an object`);
    if (typeof entry.schemaUri !== "string" || !SCHEMA_URI_PATTERN.test(entry.schemaUri)) {
      throw new Error(`Canonical schema lock entry ${index} has an invalid schemaUri`);
    }
    if (typeof entry.schemaHash !== "string" || !SHA256_PATTERN.test(entry.schemaHash)) {
      throw new Error(`Canonical schema lock entry ${index} has an invalid schemaHash`);
    }
    if (typeof entry.schemaPath !== "string") {
      throw new Error(`Canonical schema lock entry ${index} has an invalid schemaPath`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
