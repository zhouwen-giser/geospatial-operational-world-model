export const RESET_ACK_TOPIC = "/sim/reset_ack";
export const RESET_ACK_POLICY = "RESET_ACK_ACCEPTED_COMPLETE_V1";
export interface ResetAck { ok: boolean; target: string; ts: number; error?: string }
export function decodeResetAck(payload: Buffer): ResetAck {
  let value: unknown = JSON.parse(payload.toString("utf8"));
  if (value && typeof value === "object" && "data" in value) {
    const data = (value as {data: unknown}).data;
    if (typeof data !== "string") throw new Error("RESET_ACK_INVALID_WRAPPER");
    value = JSON.parse(data);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RESET_ACK_INVALID");
  const v = value as Record<string,unknown>;
  if (typeof v.ok !== "boolean" || typeof v.target !== "string" || !v.target.length
      || typeof v.ts !== "number" || !Number.isFinite(v.ts) || v.ts <= 0
      || !Number.isFinite(new Date(v.ts*1000).getTime())
      || (v.error !== undefined && typeof v.error !== "string")) throw new Error("RESET_ACK_INVALID");
  return {ok:v.ok,target:v.target,ts:v.ts,...(typeof v.error==="string"?{error:v.error}:{})};
}
