import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";

export const UGV_AUTHORITY_TOPICS = [
  "/ugv/gnss",
  "/ugv/speed",
  "status/ugv",
  "/ugv/mission_state",
  "/ugv/area_recon/status",
  "/ugv/area_recon/targets",
  "/ugv/area_recon/exception"
] as const;
export type UgvAuthorityTopic = typeof UGV_AUTHORITY_TOPICS[number];

const finite = z.number().finite();
const header = z.object({ stamp: z.object({ sec: z.number(), nanosec: z.number() }).passthrough().optional() }).passthrough().optional();
export const topicSchemas: Record<UgvAuthorityTopic, z.ZodType> = {
  "/ugv/gnss": z.object({ header, latitude: finite.min(-90).max(90), longitude: finite.min(-180).max(180), altitude: finite }).passthrough(),
  "/ugv/speed": z.union([finite, z.object({ data: finite }).passthrough()]),
  "status/ugv": z.union([
    z.object({ available: z.literal(false) }).passthrough(),
    z.object({ available: z.boolean().optional() }).passthrough().refine((value) => Object.keys(value).length > 0)
  ]),
  "/ugv/mission_state": z.object({ header, entity_id: z.string().optional(), id: z.number().int(), type: z.number().int(), state: z.number().int().min(0).max(5), progress: finite.min(0).max(100) }).passthrough(),
  "/ugv/area_recon/status": z.object({
    status: z.number().int().refine((value) => (value >= 1 && value <= 13) || value === 99),
    status_label: z.string(), camera_fault: z.boolean().optional(), out_of_range: z.boolean().optional(),
    progress: finite.min(0).max(100).optional(), coverage: finite.min(0).max(100).optional(),
    lock: z.record(z.string(), z.unknown()).optional(), last_cmd_ack: z.record(z.string(), z.unknown()).nullable().optional(),
    region: z.object({ type: z.number().int(), points: z.array(z.tuple([finite,finite])) }).nullable().optional()
  }).passthrough(),
  "/ugv/area_recon/targets": z.object({ targets: z.array(z.object({
    capture_time_us: z.number().int(), target_id: z.number().int(), type: z.number().int(),
    position: z.object({ longitude: finite.min(-180).max(180), latitude: finite.min(-90).max(90), altitude: finite }),
    velocity: z.object({ vel_e: finite, vel_n: finite, vel_u: finite }), distance: finite.nonnegative(),
    confidence: finite.min(0).max(1), threat: z.number().int().min(0).max(10), damage: z.number().int(), iff: z.number().int(),
    lock_time: z.number().int(), pixel_pos: z.object({ x: finite, y: finite, theta: finite, w: finite, h: finite }), role_name: z.string()
  }).passthrough()).max(256) }).passthrough(),
  "/ugv/area_recon/exception": z.object({
    kind: z.enum(["motion","equipment","object_loss"]), level: z.number().int(), error_code: z.number().int(),
    time_us: z.number().int().optional(), target_info: z.record(z.string(), z.unknown()).optional()
  }).passthrough()
};

export interface SourceSchemaLock {
  lockVersion: "1.0";
  sourceDirectory: string;
  files: Array<{ name: string; sha256: string; bytes: number }>;
  topicSchemaHash: string;
  validatedTopics: string[];
  topicSchemas: Record<UgvAuthorityTopic, Record<string,unknown>>;
  schemaDocuments: Record<string,Record<string,unknown>>;
}

export async function loadSourceSchemaLock(directory: string): Promise<SourceSchemaLock> {
  if (!directory.startsWith("/")) throw new Error("UGV_EQUIPMENT_SCHEMA_DIR must be absolute");
  const sourceDirectory = await realpath(directory);
  const names = ["mqtt_topics.json","mcp_ugv.json","error_codes.json"];
  const locked = new Map<string,{ file: SourceSchemaLock["files"][number]; document: Record<string,unknown> }>();
  const lockDocument = async (name: string): Promise<Record<string,unknown>> => {
    const normalized = safeSchemaPath(sourceDirectory,name);
    const existing = locked.get(normalized);
    if (existing) return existing.document;
    const path = resolve(sourceDirectory,normalized);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${normalized} must be a regular, non-symlink file`);
    const bytes = await readFile(path);
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${normalized} must contain a JSON object`);
    const document = parsed as Record<string,unknown>;
    locked.set(normalized,{ file: { name: normalized,sha256: sha256(bytes),bytes: bytes.byteLength },document });
    for (const reference of collectExternalSchemaReferences(document)) {
      await lockDocument(resolveSchemaReference(normalized,reference));
    }
    return document;
  };
  let topics: Record<string, unknown> | undefined;
  let tools: Record<string, unknown> | undefined;
  let errorCodes: Record<string, unknown> | undefined;
  for (const name of names) {
    const parsed = await lockDocument(name);
    if (name === "mqtt_topics.json") topics = parsed;
    if (name === "mcp_ugv.json") tools = parsed;
    if (name === "error_codes.json") errorCodes = parsed;
  }
  validateMcpTools(tools);
  validateErrorCodeDomains(errorCodes);
  const topicSchemas = {} as Record<UgvAuthorityTopic,Record<string,unknown>>;
  for (const topic of UGV_AUTHORITY_TOPICS) {
    const template = topic.replaceAll("ugv","{id}");
    const schema = topics?.[template];
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(`BLOCKED_SOURCE_CONTRACT_CONFLICT: mqtt_topics.json lacks ${template}`);
    }
    topicSchemas[topic] = schema as Record<string,unknown>;
  }
  const files = [...locked.values()].map((entry) => entry.file).sort((left,right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const topicFile = files.find((file) => file.name === "mqtt_topics.json");
  if (!topicFile) throw new Error("mqtt_topics.json was not locked");
  return { lockVersion: "1.0",sourceDirectory,files,topicSchemaHash: topicFile.sha256,
    validatedTopics: [...UGV_AUTHORITY_TOPICS],topicSchemas,
    schemaDocuments: Object.fromEntries([...locked.entries()].filter(([name]) => !names.includes(name)).map(([name,entry]) => [name,entry.document])) };
}

function safeSchemaPath(root: string,name: string): string {
  if (!name || name.includes("\0")) throw new Error("source schema reference is empty or unsafe");
  const path = resolve(root,name);
  const fromRoot = relative(root,path);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || resolve(root,fromRoot) !== path) {
    if (!fromRoot) return name;
    throw new Error(`BLOCKED_SOURCE_CONTRACT_CONFLICT: schema reference escapes source directory: ${name}`);
  }
  return fromRoot.replaceAll("\\","/");
}

function collectExternalSchemaReferences(value: unknown): string[] {
  const references = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) { for (const item of candidate) visit(item); return; }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key,item] of Object.entries(candidate as Record<string,unknown>)) {
      if (key === "$ref" && typeof item === "string" && !item.startsWith("#")) references.add(item);
      else visit(item);
    }
  };
  visit(value);
  return [...references].sort();
}

function resolveSchemaReference(fromName: string,reference: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference)) {
    throw new Error(`BLOCKED_SOURCE_CONTRACT_CONFLICT: remote source schema reference is forbidden: ${reference}`);
  }
  const file = reference.split("#",1)[0];
  if (!file || file.includes("?")) throw new Error(`BLOCKED_SOURCE_CONTRACT_CONFLICT: invalid source schema reference: ${reference}`);
  return relative("/",resolve("/",dirname(fromName),decodeURIComponent(file)));
}

function validateMcpTools(candidate: Record<string,unknown> | undefined): void {
  if (!candidate || Object.keys(candidate).length === 0) throw new Error("BLOCKED_SOURCE_CONTRACT_CONFLICT: mcp_ugv.json has no tools");
  for (const [name,entry] of Object.entries(candidate)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`BLOCKED_SOURCE_CONTRACT_CONFLICT: mcp_ugv.json tool ${name} is invalid`);
    const record = entry as Record<string,unknown>;
    if (typeof record.description !== "string" || !isJsonSchema(record.input) || !isJsonSchema(record.output)) {
      throw new Error(`BLOCKED_SOURCE_CONTRACT_CONFLICT: mcp_ugv.json tool ${name} lacks description/input/output`);
    }
  }
}

function validateErrorCodeDomains(candidate: Record<string,unknown> | undefined): void {
  if (!candidate || !isJsonSchema(candidate.mcp_error_codes) || !isJsonSchema(candidate.mqtt_exception_codes)) {
    throw new Error("BLOCKED_SOURCE_CONTRACT_CONFLICT: error_codes.json must separate MCP and MQTT exception domains");
  }
  const runtime = candidate.mqtt_exception_codes as Record<string,unknown>;
  for (const code of ["0x0001","0x0006","0x0010"]) {
    if (typeof runtime[code] !== "string" || runtime[code].length === 0) {
      throw new Error(`BLOCKED_SOURCE_CONTRACT_CONFLICT: error_codes.json lacks MQTT runtime exception ${code}`);
    }
  }
}

function isJsonSchema(value: unknown): value is Record<string,unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function decodePayload(topic: UgvAuthorityTopic, payload: Buffer): unknown {
  const outer = JSON.parse(payload.toString("utf8")) as unknown;
  const wrapped = topic.startsWith("/ugv/area_recon/");
  if (wrapped && outer && typeof outer === "object" && typeof (outer as { data?: unknown }).data === "string") {
    return JSON.parse((outer as { data: string }).data) as unknown;
  }
  return outer;
}

export function validatePayload(topic: UgvAuthorityTopic, candidate: unknown): { success: true; data: unknown } | { success: false; errors: unknown[] } {
  const parsed = topicSchemas[topic].safeParse(candidate);
  return parsed.success ? { success: true,data: parsed.data } : { success: false,errors: parsed.error.issues };
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
