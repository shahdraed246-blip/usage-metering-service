import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgres://app:app@localhost:5433/metering_test",
    },
    setupFiles: ["tests/setup.ts"],
    testTimeout: 20000,
  },
});
