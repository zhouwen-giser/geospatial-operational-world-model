import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["validation/foundation-ports/**/*.test.ts"],
    sequence: { concurrent: false },
    testTimeout: 10_000
  }
});
