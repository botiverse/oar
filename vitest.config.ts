import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./sea-trial/global-setup.ts"],
    include: [
      "tests/**/*.test.ts",
      "sea-trial/vendor/*.test.ts",
    ],
    // The CI check enables the scripted community unit tests on every platform.
    // Vendor files (*.vendor.test.ts) skip unless OAR_TEST names their backend; exclude them when OAR_TEST is unset.
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.OAR_COMMUNITY_TESTS === undefined ? ["tests/community/**"] : []),
      ...(process.env.OAR_TEST === undefined ? ["sea-trial/vendor/*.vendor.test.ts"] : []),
    ],
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
