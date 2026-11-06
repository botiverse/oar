import { defineConfig } from "vitest/config";
import base from "../../vitest.config.js";

// The same vendor suite and deadlines, with observation enabled only here.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    globalSetup: ["./experiments/windows-codex-ci/global-setup.ts"],
    setupFiles: ["./experiments/windows-codex-ci/setup.ts"],
    reporters: ["default", "./experiments/windows-codex-ci/reporter.ts"],
  },
});
