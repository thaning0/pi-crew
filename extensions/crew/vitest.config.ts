import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules"],
    testTimeout: 15_000,
    hookTimeout: 10_000,
  },
});
