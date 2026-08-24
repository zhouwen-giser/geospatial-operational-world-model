import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["validation/runtime-acceptance/**/*.test.ts"],
    environment: "node",
    fileParallelism: false
  }
});
