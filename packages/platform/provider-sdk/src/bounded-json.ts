import { ProviderProtocolError } from "./errors.js";

export interface BoundedJsonResponseOptions {
  maximumBytes: number;
  peerLabel: string;
  signal: AbortSignal;
}

/**
 * Reads a JSON response without ever buffering more than the configured raw-byte
 * transport budget. Content-Length is only an early rejection hint; the stream
 * counter remains authoritative for chunked and dishonest responses.
 */
export async function readBoundedJsonResponse(
  response: Response,
  options: BoundedJsonResponseOptions
): Promise<unknown> {
  const { maximumBytes, peerLabel, signal } = options;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "bounded JSON reader requires a positive byte limit", {
      retryable: false
    });
  }

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await cancelBody(response.body);
    throw budgetExceeded(peerLabel);
  }
  if (!(response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ?? false)) {
    await cancelBody(response.body);
    throw new ProviderProtocolError("SCHEMA_MISMATCH", `${peerLabel} did not return JSON`, { retryable: false });
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", `${peerLabel} returned malformed JSON`, { retryable: false });
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await readWithAbort(reader, signal);
      if (chunk.done) break;
      if (chunk.value === undefined) {
        throw new ProviderProtocolError("SCHEMA_MISMATCH", `${peerLabel} returned malformed JSON`, {
          retryable: false
        });
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw budgetExceeded(peerLabel);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ProviderProtocolError) throw error;
    if (signal.aborted) throw error;
    throw new ProviderProtocolError("SCHEMA_MISMATCH", `${peerLabel} returned malformed JSON`, {
      retryable: false,
      cause: error
    });
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", `${peerLabel} returned malformed JSON`, {
      retryable: false,
      cause: error
    });
  }
}

function budgetExceeded(peerLabel: string): ProviderProtocolError {
  return new ProviderProtocolError("BUDGET_EXCEEDED", `${peerLabel} response exceeds the bridge limit`);
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body !== null) await body.cancel().catch(() => undefined);
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal.aborted) {
    await reader.cancel().catch(() => undefined);
    throw signal.reason;
  }
  return await new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
    const abort = (): void => {
      void reader.cancel().catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}
