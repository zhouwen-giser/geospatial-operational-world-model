import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["validation/h3-bridge/**/*.test.ts"],
    environment: "node"
  }
});
