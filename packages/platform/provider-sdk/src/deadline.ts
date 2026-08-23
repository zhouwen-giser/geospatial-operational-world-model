import { ProviderProtocolError } from "./errors.js";

const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

export interface DeadlineContext {
  signal: AbortSignal;
  deadlineAt: string;
  remainingMs(): number;
}

export async function runWithDeadline<T>(
  deadlineAt: string,
  action: (context: DeadlineContext) => Promise<T>,
  now: () => number = Date.now
): Promise<T> {
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) {
    throw new ProviderProtocolError("INVALID_REQUEST", "executionPolicy.deadlineAt must be an RFC 3339 timestamp");
  }
  const remaining = deadline - now();
  if (remaining <= 0) throw new ProviderProtocolError("DEADLINE_EXCEEDED", "provider execution deadline already elapsed");

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    const schedule = (): void => {
      const nextRemaining = deadline - now();
      if (nextRemaining <= 0) {
        controller.abort();
        reject(new ProviderProtocolError("DEADLINE_EXCEEDED", "provider execution deadline exceeded"));
        return;
      }
      timer = setTimeout(schedule, Math.min(nextRemaining, MAX_NODE_TIMEOUT_MS));
      timer.unref();
    };
    schedule();
  });

  try {
    return await Promise.race([
      action({ signal: controller.signal, deadlineAt, remainingMs: () => Math.max(0, deadline - now()) }),
      timeout
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
