import { describe, expect, it } from "vitest";
import { runWithDeadline } from "../../packages/platform/provider-sdk/src/index.js";

describe("Provider SDK deadline scheduling", () => {
  it("does not collapse deadlines beyond the Node timer range to one millisecond", async () => {
    const beyondNodeTimerRangeMs = 2_147_483_647 + 60_000;
    const deadlineAt = new Date(Date.now() + beyondNodeTimerRangeMs).toISOString();

    const remaining = await runWithDeadline(deadlineAt, async (context) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return context.remainingMs();
    });

    expect(remaining).toBeGreaterThan(2_147_483_647);
  });
});
