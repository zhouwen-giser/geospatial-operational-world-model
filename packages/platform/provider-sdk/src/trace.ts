import { newOpaqueId } from "./canonical.js";

export interface TraceContext {
  traceId: string;
  requestId: string;
  parentSpanId?: string;
}

export interface SafeTraceEvent {
  traceId: string;
  requestId: string;
  operationId: string;
  operationVersion: string;
  outcome: string;
  elapsedMs: number;
  inputHash?: string;
  outputHash?: string;
  providerId?: string;
}

export function createTraceContext(requestId: string, incomingTraceId?: string): TraceContext {
  const traceId = incomingTraceId && /^[a-zA-Z0-9_.:-]{1,128}$/.test(incomingTraceId)
    ? incomingTraceId
    : newOpaqueId("trace");
  return { traceId, requestId };
}

/** This shape intentionally cannot carry raw geometry, tokens, or arbitrary user data. */
export type TraceSink = (event: Readonly<SafeTraceEvent>) => void | Promise<void>;

export const noOpTraceSink: TraceSink = () => undefined;
