import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
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
}

export async function loadSourceSchemaLock(directory: string): Promise<SourceSchemaLock> {
  if (!directory.startsWith("/")) throw new Error("UGV_EQUIPMENT_SCHEMA_DIR must be absolute");
  const sourceDirectory = await realpath(directory);
  const names = ["mqtt_topics.json","mcp_ugv.json","error_codes.json"];
  const files: SourceSchemaLock["files"] = [];
  let topics: Record<string, unknown> | undefined;
  for (const name of names) {
    const path = resolve(sourceDirectory,name);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${name} must be a regular file`);
    const bytes = await readFile(path);
    files.push({ name,sha256: sha256(bytes),bytes: bytes.byteLength });
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must contain a JSON object`);
    if (name === "mqtt_topics.json") topics = parsed as Record<string, unknown>;
  }
  const requiredTemplates = UGV_AUTHORITY_TOPICS.map((topic) => topic.replaceAll("ugv","{id}"));
  for (const topic of requiredTemplates) {
    if (!topics || !(topic in topics)) throw new Error(`BLOCKED_SOURCE_CONTRACT_CONFLICT: mqtt_topics.json lacks ${topic}`);
  }
  const topicFile = files.find((file) => file.name === "mqtt_topics.json");
  if (!topicFile) throw new Error("mqtt_topics.json was not locked");
  return { lockVersion: "1.0",sourceDirectory,files,topicSchemaHash: topicFile.sha256,validatedTopics: [...UGV_AUTHORITY_TOPICS] };
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
