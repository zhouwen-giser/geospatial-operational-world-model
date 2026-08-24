import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["validation/gateway-contract/**/*.test.ts"],
    environment: "node"
  }
});
