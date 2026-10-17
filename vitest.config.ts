import { defineConfig } from "vitest/config";

// Workspace packages export their TypeScript source under this condition, so tests run without a build.
const conditions = ["mate-source"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ["{apps,packages,tests}/*/test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
