import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "apps/node/tests/**/*.test.ts",
      "apps/web/tests/**/*.test.ts",
      "apps/web/tests/**/*.test.tsx",
    ],
    testTimeout: 10000,
  },
});
