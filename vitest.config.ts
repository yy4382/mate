import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "apps/web/tests/**/*.test.ts"],
    testTimeout: 10000,
  },
});
