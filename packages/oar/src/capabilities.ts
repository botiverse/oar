/**
 * Lightweight session-capability entry: resolves an installation's
 * `SessionCapabilityDeclaration` (`installedSessionCapabilities`) without
 * loading any runtime adapter or native SDK.
 */
export { installedSessionCapabilities } from "./contracts/runtime.js";
export type {
  CompactionEvents,
  RefusableSessionOption,
  RefusedSessionOptions,
  Runtime,
  SessionCapabilityDeclaration,
} from "./contracts/runtime.js";
export type { AvailableInstallation } from "./contracts/installation.js";
export type { ManualCompaction } from "./contracts/compaction.js";
