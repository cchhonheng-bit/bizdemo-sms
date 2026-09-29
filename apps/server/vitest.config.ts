import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    include: ["test/**/*.test.ts"],
    fileParallelism: false,   // one embedded PostgreSQL, tests share it
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
