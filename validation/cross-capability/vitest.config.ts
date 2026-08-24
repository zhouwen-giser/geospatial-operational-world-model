import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  test: {
    environment: "node",
    include: ["validation/cross-capability/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false }
  }
});
