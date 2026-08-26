import { isDeepStrictEqual } from "node:util";
import { isIP } from "node:net";

import { contractSchemas } from "./generated/schema-bundle.js";
import { contractSchemaHashes } from "./generated/schema-hashes.js";
import { validateNamedContractSemantics } from "./semantic-validation.js";

export type JsonSchema = boolean | Record<string, unknown>;

export interface ValidationIssue {
  path: string;
  schemaPath: string;
  keyword: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ValidationOptions {
  schemaName?: string;
  schemas?: Readonly<Record<string, JsonSchema>>;
  maximumIssues?: number;
}

export class ContractValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(contractName: string, issues: ValidationIssue[]) {
    super(`${contractName} failed validation: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

type SchemaObject = Record<string, unknown>;

const bundledSchemas = contractSchemas as Readonly<Record<string, JsonSchema>>;
const supportedFormats = new Set([
  "date",
  "date-time",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "uuid"
]);

const normalizePath = (value: string): string => {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
};

const directoryName = (value: string): string => {
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
};

const baseName = (value: string): string => value.slice(value.lastIndexOf("/") + 1);

const schemaObject = (schema: JsonSchema): SchemaObject | undefined =>
  schema === true || schema === false ? undefined : schema;

function buildAliases(documents: Readonly<Record<string, JsonSchema>>): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  const add = (alias: string | undefined, key: string) => {
    if (!alias) return;
    const values = aliases.get(alias) ?? [];
    if (!values.includes(key)) values.push(key);
    aliases.set(alias, values);
  };
  for (const [key, rawSchema] of Object.entries(documents)) {
    const schema = schemaObject(rawSchema);
    add(key, key);
    add(baseName(key), key);
    if (schema) {
      add(typeof schema.$id === "string" ? schema.$id : undefined, key);
      add(typeof schema.title === "string" ? schema.title : undefined, key);
    }
  }
  return aliases;
}

const bundledAliases = buildAliases(bundledSchemas);

export function getContractSchema(nameOrId: string): Readonly<Record<string, unknown>> {
  const matches = bundledAliases.get(nameOrId) ?? [];
  if (matches.length === 0) throw new Error(`Unknown contract schema: ${nameOrId}`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous contract schema ${nameOrId}; use one of: ${matches.join(", ")}`);
  }
  const schema = bundledSchemas[matches[0] as string];
  if (schema === undefined) throw new Error(`Contract schema disappeared: ${nameOrId}`);
  if (schema === true || schema === false) throw new Error(`Named contract ${nameOrId} is not an object schema`);
  return schema;
}

export function getContractSchemaHash(nameOrId: string): `sha256:${string}` {
  const matches = bundledAliases.get(nameOrId) ?? [];
  if (matches.length === 0) throw new Error(`Unknown contract schema: ${nameOrId}`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous contract schema ${nameOrId}; use one of: ${matches.join(", ")}`);
  }
  const digest = contractSchemaHashes[matches[0] as string];
  if (!digest || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`Missing generated schema hash for ${nameOrId}`);
  }
  return digest as `sha256:${string}`;
}

const sourceByteSchemaHashes: Readonly<Record<string, `sha256:${string}`>> = {
  // Frozen Network 1.0 manifests use source-byte locks, like Route/Coverage.
  "urn:gowm:v0.5:network-build-request": "sha256:763a2c6eb01323275c7c30c5a84891018424ceec43d4021ee3db4cdd7db774b4",
  "urn:gowm:v0.5:network-build-result": "sha256:be1fbd02ea7c8c826c910dbbf742bde188ac19037acc419490f1529219dbbe57",
  "urn:gowm:v0.5:network-common": "sha256:1f35b48d91d8138e3a52762e9fdfb9ee21a97980b43fb6bf15126cd8faae149c",
  "urn:gowm:v0.5:network-condition-snapshot": "sha256:9b29c7dcbe62aa90321576389fd698fff74debd1932d52d4cee4a83a25d75d89",
  "urn:gowm:v0.5:network-cost-matrix-request": "sha256:6dc75cdca2990e8239dd060f1d93bed26959d37ab32507fbc96d92844bda0a55",
  "urn:gowm:v0.5:network-cost-matrix-result": "sha256:058346014c99499e53b6b58a2509ef1308c321aad10e4a2525991678824e68f7",
  "urn:gowm:v0.5:network-graph-version": "sha256:947f7f3d6a35b8e3bda52722b16f7e42dc612820c12fbd6a3b1af855dd35411c",
  "urn:gowm:v0.5:provider-manifest-extension": "sha256:4c641c6be9ac763744ddb309402cc1e60f28a49060f92280c768fd87259ba2d9",
  "urn:gowm:v0.5:network-shortest-path-request": "sha256:b1bed7cd90744523d035567b0fbae0382a8fddc014728fef93158cadbdc48355",
  "urn:gowm:v0.5:network-shortest-path-result": "sha256:c4bc84c55f7f67266f99ee799bb8c826d45df2d80ff9ad902e8d1a5669db7794",
  "urn:gowm:v0.5:network-snap-request": "sha256:d63fe16bae3534403a320abd21c79d98c9d6914c694cbe810d6773913cf084cb",
  "urn:gowm:v0.5:network-snap-result": "sha256:e606e231164ceecdece02310395b6b4742ab45b92d8a9713f196b1779dc257fd",
  "urn:gowm:v0.5:route-planning-request": "sha256:0cdee0b4a503099aef05e738a323ae57414c7f0c9cdba7997f86e89ed045da67",
  "urn:gowm:v0.5:route-planning-result": "sha256:e45253b2c53dfe6d40be0bdbc7cf4c33fb5d9500bff3363da2ee27da96418f8c",
  "urn:gowm:v0.5:route-verification-report": "sha256:76477a2cf770bb5a72208882aa841ac7b13f60e0516a4726ff265efcbdbea8bd",
  "urn:gowm:v0.6:road-coverage-request": "sha256:01a1ff79cfdb0277f25e500c4fd6662564e25e15ad03be7f241d03047cc2100e",
  "urn:gowm:v0.6:coverage-validation-result": "sha256:f8df6f34dca1ffeab2dcbca60be2dfecc408a3312b359816fc16be4ca125f55a",
  "urn:gowm:v0.6:coverage-obligation-set": "sha256:f453949199ebdf7eea944c5eac3fbff95bfc52cdb0f8a33abecb38fe6448cbbe",
  "urn:gowm:v0.6:coverage-result-set": "sha256:6780705366b28bf95ee1868b48587839f50acbe5aa950b3ed256b7d64bd30c50",
  "urn:gowm:v0.6:coverage-verification-request": "sha256:f8f242440dbb82ea5790ae163455a838d53da451e0481fa36c2b111c423dfcfa",
  "urn:gowm:v0.6:coverage-verification-report": "sha256:56063206dc0164bd273a69784a4cc91a9211130f7f71aa2dbbf776cbe20f9584",
  "urn:gowm:v0.6:coverage-expand-request": "sha256:64f0a1a67d9802a0d41f087f3482158ba7bafa5722dd94cda5314786beb24f37",
  "urn:gowm:v0.6:coverage-geojson-result": "sha256:e5c8b4845f9f0717750adb2b5f1b0303f00fd302c1cb962a0336af37474c1b0b"
};

/** Accepts the canonical schema digest or an explicitly frozen source-byte digest. */
export function isContractSchemaHash(nameOrId: string, digest: string): boolean {
  return getContractSchemaHash(nameOrId) === digest || sourceByteSchemaHashes[nameOrId] === digest;
}

export function listContractSchemas(): Array<{ key: string; id?: string; title?: string }> {
  return Object.entries(bundledSchemas)
    .map(([key, rawSchema]) => {
      const schema = schemaObject(rawSchema);
      const result: { key: string; id?: string; title?: string } = { key };
      if (typeof schema?.$id === "string") result.id = schema.$id;
      if (typeof schema?.title === "string") result.title = schema.title;
      return result;
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function appendPath(path: string, property: string | number): string {
  return `${path}/${escapePointer(String(property))}`;
}

function resolvePointer(document: JsonSchema, fragment: string): JsonSchema {
  if (!fragment || fragment === "#") return document;
  const pointer = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!pointer.startsWith("/")) throw new Error(`Unsupported JSON Schema fragment: ${fragment}`);
  let current: unknown = document;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !(part in current)) {
      throw new Error(`Unresolved JSON Pointer ${fragment}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== "boolean" && (!current || typeof current !== "object")) {
    throw new Error(`JSON Pointer ${fragment} does not select a schema`);
  }
  return current as JsonSchema;
}

interface ResolvedSchema {
  key: string;
  schema: JsonSchema;
  schemaPath: string;
}

function resolveReference(
  reference: string,
  currentKey: string,
  documents: Readonly<Record<string, JsonSchema>>,
  aliases: Map<string, string[]>
): ResolvedSchema {
  const hashIndex = reference.indexOf("#");
  const documentPart = hashIndex < 0 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex < 0 ? "" : reference.slice(hashIndex);
  let targetKey = currentKey;
  if (documentPart) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(documentPart)) {
      const matches = aliases.get(documentPart) ?? [];
      if (matches.length !== 1) throw new Error(`Unresolved or ambiguous schema id ${documentPart}`);
      targetKey = matches[0] as string;
    } else {
      targetKey = normalizePath(`${directoryName(currentKey)}/${documentPart}`);
    }
  }
  const document = documents[targetKey];
  if (document === undefined) throw new Error(`Unresolved schema document ${targetKey}`);
  return {
    key: targetKey,
    schema: resolvePointer(document, fragment),
    schemaPath: `${targetKey}${fragment}`
  };
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return false;
  }
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validFormat(format: string, value: string): boolean {
  switch (format) {
    case "date":
      return validDate(value);
    case "date-time": {
      const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
      if (!match || !validDate(match[1] as string)) return false;
      const hour = Number(match[2]);
      const minute = Number(match[3]);
      const second = Number(match[4]);
      if (hour > 23 || minute > 59 || second > 60) return false;
      if (match[5] !== "Z") {
        const offset = /[+-](\d{2}):(\d{2})/u.exec(match[5] as string);
        if (!offset || Number(offset[1]) > 23 || Number(offset[2]) > 59) return false;
      }
      return !Number.isNaN(Date.parse(value));
    }
    case "duration":
      return /^P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/u.test(value);
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
    case "hostname":
      return value.length <= 253 && value.split(".").every((part) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/u.test(part));
    case "ipv4":
      return isIP(value) === 4;
    case "ipv6":
      return isIP(value) === 6;
    case "uri":
      try {
        return /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) && Boolean(new URL(value));
      } catch {
        return false;
      }
    case "uri-reference":
      try {
        return Boolean(new URL(value, "https://gowm.invalid/"));
      } catch {
        return false;
      }
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
    default:
      return false;
  }
}

interface WalkContext {
  documents: Readonly<Record<string, JsonSchema>>;
  aliases: Map<string, string[]>;
  issues: ValidationIssue[];
  maximumIssues: number;
}

function addIssue(
  context: WalkContext,
  path: string,
  schemaPath: string,
  keyword: string,
  message: string
): void {
  if (context.issues.length < context.maximumIssues) {
    context.issues.push({ path, schemaPath, keyword, message });
  }
}

function trial(
  schema: JsonSchema,
  value: unknown,
  path: string,
  schemaPath: string,
  currentKey: string,
  context: WalkContext
): ValidationIssue[] {
  const local: WalkContext = { ...context, issues: [] };
  walk(schema, value, path, schemaPath, currentKey, local);
  return local.issues;
}

function walk(
  rawSchema: JsonSchema,
  value: unknown,
  path: string,
  schemaPath: string,
  currentKey: string,
  context: WalkContext
): void {
  if (context.issues.length >= context.maximumIssues) return;
  if (rawSchema === true) return;
  if (rawSchema === false) {
    addIssue(context, path, schemaPath, "falseSchema", "is rejected by the schema");
    return;
  }
  const schema = rawSchema;
  if (typeof schema.$ref === "string") {
    try {
      const resolved = resolveReference(schema.$ref, currentKey, context.documents, context.aliases);
      walk(resolved.schema, value, path, resolved.schemaPath, resolved.key, context);
    } catch (error) {
      addIssue(context, path, schemaPath, "$ref", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((branch, index) =>
      walk(branch as JsonSchema, value, path, `${schemaPath}/allOf/${index}`, currentKey, context)
    );
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter(
      (branch, index) => trial(branch as JsonSchema, value, path, `${schemaPath}/anyOf/${index}`, currentKey, context).length === 0
    );
    if (matches.length === 0) addIssue(context, path, `${schemaPath}/anyOf`, "anyOf", "must match at least one branch");
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      (branch, index) => trial(branch as JsonSchema, value, path, `${schemaPath}/oneOf/${index}`, currentKey, context).length === 0
    );
    if (matches.length !== 1) addIssue(context, path, `${schemaPath}/oneOf`, "oneOf", `must match exactly one branch; matched ${matches.length}`);
  }
  if (schema.not && typeof schema.not === "object") {
    if (trial(schema.not as JsonSchema, value, path, `${schemaPath}/not`, currentKey, context).length === 0) {
      addIssue(context, path, `${schemaPath}/not`, "not", "must not match the excluded schema");
    }
  }
  if (schema.if && typeof schema.if === "object") {
    const matches = trial(schema.if as JsonSchema, value, path, `${schemaPath}/if`, currentKey, context).length === 0;
    const selected = matches ? schema.then : schema.else;
    if (selected && typeof selected === "object") {
      walk(selected as JsonSchema, value, path, `${schemaPath}/${matches ? "then" : "else"}`, currentKey, context);
    }
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) {
    addIssue(context, path, `${schemaPath}/const`, "const", `must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => isDeepStrictEqual(candidate, value))) {
    addIssue(context, path, `${schemaPath}/enum`, "enum", "must be one of the allowed values");
  }
  const declaredTypes = Array.isArray(schema.type)
    ? schema.type.filter((entry): entry is string => typeof entry === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => typeMatches(type, value))) {
    addIssue(context, path, `${schemaPath}/type`, "type", `must be ${declaredTypes.join(" or ")}`);
    return;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) {
      addIssue(context, path, `${schemaPath}/minLength`, "minLength", `must contain at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) {
      addIssue(context, path, `${schemaPath}/maxLength`, "maxLength", `must contain at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) {
          addIssue(context, path, `${schemaPath}/pattern`, "pattern", `must match ${schema.pattern}`);
        }
      } catch {
        addIssue(context, path, `${schemaPath}/pattern`, "pattern", "schema contains an invalid regular expression");
      }
    }
    if (typeof schema.format === "string") {
      if (!supportedFormats.has(schema.format)) {
        addIssue(context, path, `${schemaPath}/format`, "format", `unsupported format ${schema.format}`);
      } else if (!validFormat(schema.format, value)) {
        addIssue(context, path, `${schemaPath}/format`, "format", `must be a valid ${schema.format}`);
      }
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      addIssue(context, path, `${schemaPath}/minimum`, "minimum", `must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      addIssue(context, path, `${schemaPath}/maximum`, "maximum", `must be at most ${schema.maximum}`);
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      addIssue(context, path, `${schemaPath}/exclusiveMinimum`, "exclusiveMinimum", `must be greater than ${schema.exclusiveMinimum}`);
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      addIssue(context, path, `${schemaPath}/exclusiveMaximum`, "exclusiveMaximum", `must be less than ${schema.exclusiveMaximum}`);
    }
    if (typeof schema.multipleOf === "number" && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > Number.EPSILON * 10) {
      addIssue(context, path, `${schemaPath}/multipleOf`, "multipleOf", `must be a multiple of ${schema.multipleOf}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      addIssue(context, path, `${schemaPath}/minItems`, "minItems", `must contain at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      addIssue(context, path, `${schemaPath}/maxItems`, "maxItems", `must contain at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      for (let index = 0; index < value.length; index += 1) {
        if (value.slice(0, index).some((candidate) => isDeepStrictEqual(candidate, value[index]))) {
          addIssue(context, appendPath(path, index), `${schemaPath}/uniqueItems`, "uniqueItems", "must not duplicate another item");
          break;
        }
      }
    }
    if (schema.items && (typeof schema.items === "object" || typeof schema.items === "boolean")) {
      value.forEach((item, index) => walk(schema.items as JsonSchema, item, appendPath(path, index), `${schemaPath}/items`, currentKey, context));
    }
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((itemSchema, index) => {
        if (index < value.length && (typeof itemSchema === "object" || typeof itemSchema === "boolean")) {
          walk(itemSchema as JsonSchema, value[index], appendPath(path, index), `${schemaPath}/prefixItems/${index}`, currentKey, context);
        }
      });
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
      addIssue(context, path, `${schemaPath}/minProperties`, "minProperties", `must contain at least ${schema.minProperties} properties`);
    }
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
      addIssue(context, path, `${schemaPath}/maxProperties`, "maxProperties", `must contain at most ${schema.maxProperties} properties`);
    }
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
    for (const property of required) {
      if (!Object.hasOwn(objectValue, property)) {
        addIssue(context, appendPath(path, property), `${schemaPath}/required`, "required", "is required");
      }
    }
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, JsonSchema>)
      : {};
    const patternProperties = schema.patternProperties && typeof schema.patternProperties === "object" && !Array.isArray(schema.patternProperties)
      ? (schema.patternProperties as Record<string, JsonSchema>)
      : {};
    for (const [property, propertyValue] of Object.entries(objectValue)) {
      if (Object.hasOwn(properties, property)) {
        walk(properties[property] as JsonSchema, propertyValue, appendPath(path, property), `${schemaPath}/properties/${escapePointer(property)}`, currentKey, context);
        continue;
      }
      const matchingPatterns = Object.entries(patternProperties).filter(([pattern]) => new RegExp(pattern, "u").test(property));
      if (matchingPatterns.length > 0) {
        for (const [pattern, patternSchema] of matchingPatterns) {
          walk(patternSchema, propertyValue, appendPath(path, property), `${schemaPath}/patternProperties/${escapePointer(pattern)}`, currentKey, context);
        }
        continue;
      }
      if (schema.additionalProperties === false) {
        addIssue(context, appendPath(path, property), `${schemaPath}/additionalProperties`, "additionalProperties", "is not allowed");
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        walk(schema.additionalProperties as JsonSchema, propertyValue, appendPath(path, property), `${schemaPath}/additionalProperties`, currentKey, context);
      }
    }
    if (schema.propertyNames && typeof schema.propertyNames === "object") {
      for (const property of keys) {
        walk(schema.propertyNames as JsonSchema, property, appendPath(path, property), `${schemaPath}/propertyNames`, currentKey, context);
      }
    }
  }
}

export function validateAgainstSchema(
  schema: JsonSchema,
  value: unknown,
  options: ValidationOptions = {}
): ValidationResult {
  const inlineKey = options.schemaName ?? "inline.schema.json";
  const documents: Record<string, JsonSchema> = { ...bundledSchemas, ...(options.schemas ?? {}) };
  if (!Object.values(documents).some((candidate) => candidate === schema)) documents[inlineKey] = schema;
  const currentKey = Object.entries(documents).find(([, candidate]) => candidate === schema)?.[0] ?? inlineKey;
  const context: WalkContext = {
    documents,
    aliases: buildAliases(documents),
    issues: [],
    maximumIssues: options.maximumIssues ?? 100
  };
  walk(schema, value, "", currentKey, currentKey, context);
  return { valid: context.issues.length === 0, issues: context.issues };
}

export function assertAgainstSchema<T = unknown>(
  schema: JsonSchema,
  value: unknown,
  options: ValidationOptions = {}
): asserts value is T {
  const result = validateAgainstSchema(schema, value, options);
  if (!result.valid) throw new ContractValidationError(options.schemaName ?? "inline schema", result.issues);
}

export function validateContract(nameOrId: string, value: unknown): ValidationResult {
  const schema = getContractSchema(nameOrId);
  const structural = validateAgainstSchema(schema, value, { schemaName: nameOrId });
  if (!structural.valid) return structural;
  const semantic = validateNamedContractSemantics(nameOrId, value);
  return {
    valid: semantic.length === 0,
    issues: semantic
  };
}

export function assertContract<T = unknown>(nameOrId: string, value: unknown): asserts value is T {
  const result = validateContract(nameOrId, value);
  if (!result.valid) throw new ContractValidationError(nameOrId, result.issues);
}

export function validateSchemaSet(): ValidationResult {
  const issues: ValidationIssue[] = [];
  const ids = new Map<string, string>();
  const aliases = buildAliases(bundledSchemas);
  const visit = (schema: JsonSchema, key: string, schemaPath: string) => {
    if (schema === true || schema === false) return;
    if (typeof schema.$id === "string") {
      const previous = ids.get(schema.$id);
      if (previous) issues.push({ path: key, schemaPath, keyword: "$id", message: `duplicates ${previous}` });
      else ids.set(schema.$id, schemaPath);
    }
    if (typeof schema.format === "string" && !supportedFormats.has(schema.format)) {
      issues.push({ path: key, schemaPath: `${schemaPath}/format`, keyword: "format", message: `unsupported format ${schema.format}` });
    }
    if (typeof schema.$ref === "string") {
      try {
        resolveReference(schema.$ref, key, bundledSchemas, aliases);
      } catch (error) {
        issues.push({ path: key, schemaPath: `${schemaPath}/$ref`, keyword: "$ref", message: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const [property, child] of Object.entries(schema)) {
      if (child && typeof child === "object") {
        if (Array.isArray(child)) {
          child.forEach((entry, index) => {
            if (entry && (typeof entry === "object" || typeof entry === "boolean")) visit(entry as JsonSchema, key, `${schemaPath}/${property}/${index}`);
          });
        } else {
          visit(child as JsonSchema, key, `${schemaPath}/${property}`);
        }
      }
    }
  };
  for (const [key, schema] of Object.entries(bundledSchemas)) visit(schema, key, key);
  return { valid: issues.length === 0, issues };
}
