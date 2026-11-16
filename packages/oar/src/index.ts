/* oxlint-disable import/max-dependencies -- The root entry is the composition point for all built-in runtimes. */
import { RuntimeRegistry } from "./registry.js";
import { antigravityRuntime } from "./runtimes/antigravity/index.js";
import { claudeRuntime } from "./runtimes/claude/index.js";
import { codebuddyRuntime } from "./runtimes/codebuddy/index.js";
import { codexRuntime } from "./runtimes/codex/index.js";
import { devinRuntime } from "./runtimes/devin/index.js";
import { dshRuntime } from "./runtimes/dsh/index.js";
import { factoryRuntime } from "./runtimes/factory/index.js";
import { grokRuntime } from "./runtimes/grok/index.js";
import { kimiRuntime } from "./runtimes/kimi/index.js";
import { opencodeRuntime } from "./runtimes/opencode/index.js";
import { piRuntime } from "./runtimes/pi/index.js";
import { qoderRuntime } from "./runtimes/qoder/index.js";
import { qwenRuntime } from "./runtimes/qwen/index.js";

export * from "./contracts/index.js";
export { utcInstantFromDate } from "./shared/instant.js";
export { RuntimeRegistry, createRuntimeRegistry } from "./registry.js";
export { openVoyage } from "./voyage.js";
export type { VoyageHeader, VoyageRecorder } from "./voyage.js";
export { serveMcpTools } from "./mcp/serve-tools.js";
export type { HostTool, HostToolContent, HostToolResult, ServeMcpToolsOptions, ServedMcpTools } from "./mcp/serve-tools.js";
// Everything the browser-safe observe subpath exports, so the root is the full surface.
export * from "./observe/index.js";
export { claudeRuntime } from "./runtimes/claude/index.js";

export { claudeInstallation } from "./runtimes/claude/installation.js";
export { codexRuntime } from "./runtimes/codex/index.js";

export { createPiProviderAuth } from "./runtimes/pi/auth.js";
export type { PiProviderAuthOptions } from "./runtimes/pi/auth.js";

export { antigravityRuntime } from "./runtimes/antigravity/index.js";

export { createCursorRuntime, cursorNativeEnvironment } from "./runtimes/cursor/index.js";
export type { CursorRuntime, CursorRuntimeOptions } from "./runtimes/cursor/index.js";
export type { CursorSdk, ModelListItem as CursorModelListItem } from "./runtimes/cursor/sdk.js";

export { grokRuntime } from "./runtimes/grok/index.js";

export { kimiRuntime } from "./runtimes/kimi/index.js";
export type { KimiLoginOptions } from "./runtimes/kimi/login.js";

export { opencodeRuntime } from "./runtimes/opencode/index.js";

export { createOpencodeProviderAuth, OpencodeProviderAuthError } from "./runtimes/opencode/provider-auth.js";
export type { OpencodeProviderAuth, OpencodeProviderAuthErrorKind, OpencodeProviderAuthOptions } from "./runtimes/opencode/provider-auth.js";
export { qwenRuntime, createQwenProviderAuth, QwenProviderAuthError } from "./runtimes/qwen/index.js";
export type { QwenProvider, QwenProviderAuth, QwenProviderAuthOptions, QwenProviderAuthErrorKind, QwenProviderConnectOptions, QwenProviderConnectResult } from "./runtimes/qwen/index.js";

export { piRuntime, createPiRuntime, type PiRuntimeOptions } from "./runtimes/pi/index.js";

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
  codebuddyRuntime,
  devinRuntime,
  dshRuntime,
  factoryRuntime,
  grokRuntime,
  kimiRuntime,
  opencodeRuntime,
  piRuntime,
  qwenRuntime,
  qoderRuntime,
]);

export { runtimeBrands, runtimeBrandIcon } from "./brands.js";
export type { RuntimeBrand } from "./brands.js";

export { qoderRuntime } from "./runtimes/qoder/index.js";

export { orient } from "./shared/orientation/index.js";
export { userShellEnvironment } from "./shared/shell-environment.js";
export { writeShellEnvironmentCapture } from "./shared/shell-environment-capture.js";

export { factoryRuntime } from "./runtimes/factory/index.js";

export { dshRuntime } from "./runtimes/dsh/index.js";

export { codebuddyRuntime } from "./runtimes/codebuddy/index.js";

export { devinRuntime } from "./runtimes/devin/index.js";
