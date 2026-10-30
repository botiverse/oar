import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./sea-trial/global-setup.ts"],
    include: [
      "tests/**/*.test.ts",
      "sea-trial/vendor/*.test.ts",
    ],
    // Community runtimes' tests are their maintainers' (tests/community/):
    // out of CI unless OAR_COMMUNITY_TESTS is set.
    exclude: process.env.OAR_COMMUNITY_TESTS === undefined ? [...configDefaults.exclude, "tests/community/**"] : configDefaults.exclude,
    // Cold Windows runners: one powershell resolution is allowed up to 15s,
    // which does not fit vitest's 5s default (flaked in CI run 32615946478).
    testTimeout: 30_000,
    ...(process.env.OAR_TEST === "pi-rpc-aimock" && process.env.OAR_PI_RPC_DIAGNOSTICS !== undefined ? {
      reporters: ["default", "./sea-trial/pi-rpc-progress.ts"],
      setupFiles: ["./sea-trial/pi-rpc-stderr.ts"],
    } : {}),
    update: process.env.CI === undefined ? "all" : "none",
  },
});
