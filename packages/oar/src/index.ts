import { RuntimeRegistry } from "./registry.js";
import { claudeRuntime } from "./runtimes/claude/index.js";
import { codexRuntime } from "./runtimes/codex/index.js";
import { piRuntime } from "./runtimes/pi/index.js";

export type {
  AccountUsageReader,
  AccountUsageReadOptions,
  AccountUsageSnapshot,
  AccountUsageWindow,
} from "./contracts/account-usage.js";
export type {
  AvailableInstallation,
  BundledInstallation,
  ExecutableInstallation,
  InstallationProbe,
  InstallationSnapshot,
} from "./contracts/installation.js";
export type { Runtime } from "./contracts/runtime.js";
export { defineRuntime } from "./contracts/runtime.js";
export { RuntimeRegistry, createRuntimeRegistry } from "./registry.js";
export { claudeRuntime } from "./runtimes/claude/index.js";
export { codexRuntime } from "./runtimes/codex/index.js";
export { piRuntime } from "./runtimes/pi/index.js";

export const runtimes = new RuntimeRegistry([claudeRuntime, codexRuntime, piRuntime]);
