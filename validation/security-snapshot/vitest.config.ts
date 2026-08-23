import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["validation/security-snapshot/**/*.test.ts"],
    environment: "node"
  }
});
