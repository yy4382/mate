import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/container/*.integration.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
