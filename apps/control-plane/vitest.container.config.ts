import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    reporters: ["default"],
    include: ["tests/container/*.integration.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
