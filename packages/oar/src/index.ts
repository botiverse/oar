import { RuntimeRegistry } from "./registry.js";
import { antigravityRuntime } from "./runtimes/antigravity/index.js";
import { claudeRuntime } from "./runtimes/claude/index.js";
import { codexRuntime } from "./runtimes/codex/index.js";
import { grokRuntime } from "./runtimes/grok/index.js";
import { kimiRuntime } from "./runtimes/kimi/index.js";
import { opencodeRuntime } from "./runtimes/opencode/index.js";
import { piRuntime } from "./runtimes/pi/index.js";

export * from "./contracts/index.js";
export { utcInstantFromDate } from "./shared/instant.js";
export { RuntimeRegistry, createRuntimeRegistry } from "./registry.js";
export {
  VOYAGE_FORMAT,
  endLine,
  headerLine,
  openVoyage,
  recordLine,
} from "./voyage.js";
export type { VoyageHeader, VoyageRecorder } from "./voyage.js";
// Everything the browser-safe observe subpath exports, so the root is the full surface.
export * from "./observe/index.js";
export { claudeRuntime } from "./runtimes/claude/index.js";
export { claudeListModels, projectClaudeModels } from "./runtimes/claude/list-models.js";
export { claudeSession } from "./runtimes/claude/session.js";
export { claudeInstallation } from "./runtimes/claude/installation.js";
export { codexRuntime } from "./runtimes/codex/index.js";
export { codexListModels, projectCodexModels } from "./runtimes/codex/list-models.js";
export { codexSession } from "./runtimes/codex/session.js";
export { codexInstallation } from "./runtimes/codex/installation.js";
export { createPiProviderAuth } from "./runtimes/pi/auth.js";
export type { PiProviderAuthOptions } from "./runtimes/pi/auth.js";
export { createPiModelCatalog } from "./runtimes/pi/catalog.js";
export type { PiModelCatalogOptions } from "./runtimes/pi/catalog.js";
export { antigravityRuntime } from "./runtimes/antigravity/index.js";
export { antigravitySession } from "./runtimes/antigravity/session.js";
export { antigravityInstallation } from "./runtimes/antigravity/installation.js";
export { antigravityListModels, projectAntigravityModels } from "./runtimes/antigravity/list-models.js";
export { createCursorRuntime, projectCursorModels } from "./runtimes/cursor/index.js";
export type { CursorRuntime, CursorRuntimeOptions } from "./runtimes/cursor/index.js";
export type { CursorSdk, ModelListItem as CursorModelListItem } from "./runtimes/cursor/sdk.js";
export { cursorInstallation } from "./runtimes/cursor/installation.js";
export { grokRuntime } from "./runtimes/grok/index.js";
export { grokListModels, projectGrokModels } from "./runtimes/grok/list-models.js";
export { grokSession } from "./runtimes/grok/session.js";
export { grokInstallation } from "./runtimes/grok/installation.js";
export { kimiRuntime } from "./runtimes/kimi/index.js";
export { kimiListModels, projectKimiModels } from "./runtimes/kimi/list-models.js";
export { kimiSession } from "./runtimes/kimi/session.js";
export { kimiInstallation } from "./runtimes/kimi/installation.js";
export { opencodeRuntime } from "./runtimes/opencode/index.js";
export { opencodeListModels, projectOpencodeModels } from "./runtimes/opencode/list-models.js";
export { opencodeSession } from "./runtimes/opencode/session.js";
export { opencodeInstallation } from "./runtimes/opencode/installation.js";
export { piRuntime } from "./runtimes/pi/index.js";
export { piListModels, projectPiModels } from "./runtimes/pi/list-models.js";
export { piSession } from "./runtimes/pi/session.js";
export { piInstallation } from "./runtimes/pi/installation.js";

/**
 * The runtimes OAR builds without the host's help. Cursor is not one: its
 * SDK is the host's to install, and a host that wants it adds
 * `createCursorRuntime({ sdk: () => import("@cursor/sdk") })` to a registry
 * of its own (`createRuntimeRegistry([...defaultRuntimes.list(), cursor])`).
 */
export const defaultRuntimes = new RuntimeRegistry([
  antigravityRuntime,
  claudeRuntime,
  codexRuntime,
  grokRuntime,
  kimiRuntime,
  opencodeRuntime,
  piRuntime,
]);

export { runtimeBrands, runtimeBrandIcon } from "./brands.js";
export type { RuntimeBrand } from "./brands.js";
