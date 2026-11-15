import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config.js";

export default mergeConfig(base, defineConfig({ test: { setupFiles: ["./experiments/grok-startup/vendor-setup.ts"] } }));
