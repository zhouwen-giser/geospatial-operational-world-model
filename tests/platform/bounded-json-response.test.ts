import { describe, expect, it } from "vitest";
import { readBoundedJsonResponse } from "../../packages/platform/provider-sdk/src/index.js";

describe("bounded JSON transport reader", () => {
  it("cancels a chunked response as soon as its raw bytes exceed the limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const chunks = ["12345", "67890", ...Array.from({ length: 8 }, () => "must-not-be-read")];
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(chunk));
      },
      cancel() {
        cancelled = true;
      }
    }), {
      headers: { "content-type": "application/json" }
    });

    await expect(readBoundedJsonResponse(response, {
      maximumBytes: 8,
      peerLabel: "test upstream",
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(cancelled).toBe(true);
    // WHATWG streams may prefetch one chunk, but cancellation prevents the
    // unbounded producer from draining the remainder.
    expect(pulls).toBeLessThan(chunks.length);
  });

  it("does not trust a smaller declared Content-Length", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        controller.enqueue(new TextEncoder().encode("67890"));
        controller.close();
      }
    }), {
      headers: {
        "content-length": "2",
        "content-type": "application/json"
      }
    });

    await expect(readBoundedJsonResponse(response, {
      maximumBytes: 8,
      peerLabel: "test upstream",
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});
