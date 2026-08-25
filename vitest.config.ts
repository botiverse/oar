import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/*.test.ts",
      "tests/replay/*.test.ts",
      "sea-trial/vendor/*.test.ts",
      "apps/coxswain/test/*.test.ts",
    ],
    // Cold Windows runners: one powershell resolution is allowed up to 15s,
    // which does not fit vitest's 5s default (flaked in CI run 32615946478).
    testTimeout: 30_000,
    update: process.env.CI === undefined ? "all" : "none",
  },
});
