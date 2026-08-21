import { RuntimeRegistry } from "./registry.js";
import { claudeRuntime } from "./runtimes/claude/index.js";
import { codexRuntime } from "./runtimes/codex/index.js";

export type {
  AccountUsage,
  AccountUsageAccount,
  AccountUsageAcquisition,
  AccountUsageHealth,
  AccountUsageReadOptions,
  AccountUsageScope,
  AccountUsageSnapshot,
  AccountUsageWindow,
  AccountUsageWindowStatus,
} from "./contracts/account-usage.js";
export {
  ACCOUNT_USAGE_PROTOCOL_VERSION,
  unsupportedAccountUsage,
} from "./contracts/account-usage.js";
export type {
  Installation,
  InstallationDiagnostic,
  InstallationSnapshot,
  InstallationSource,
  InstallationState,
} from "./contracts/installation.js";
export type { Runtime } from "./contracts/runtime.js";
export { defineRuntime } from "./contracts/runtime.js";
export { RuntimeRegistry, createRuntimeRegistry } from "./registry.js";
export { claudeRuntime } from "./runtimes/claude/index.js";
export { codexRuntime } from "./runtimes/codex/index.js";

export const runtimes = new RuntimeRegistry([claudeRuntime, codexRuntime]);
