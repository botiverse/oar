import type { AvailableInstallation } from "../../contracts/installation.js";
import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { defineRuntime, type SessionCapabilityDeclaration } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { semverAtLeast, semverBelow } from "../../shared/semver.js";
import { qwenInstallation } from "./installation.js";
import { qwenCredentials } from "./credentials.js";
import { qwenInstall, qwenInstallPlan } from "./install.js";
import { qwenNativeMemoryRefusal, qwenRefusedSessionOptions } from "./options.js";

export { createQwenProviderAuth, QwenProviderAuthError } from "./provider-auth.js";
export type { QwenProvider, QwenProviderAuth, QwenProviderAuthOptions, QwenProviderAuthErrorKind, QwenProviderConnectOptions, QwenProviderConnectResult } from "./provider-auth.js";

function qwenSessionCapabilities(installation: AvailableInstallation): SessionCapabilityDeclaration {
  const version = installation.via === "executable" ? installation.version : undefined;
  const refusedSessionOptions = qwenNativeMemoryRefusal(version);
  // 0.26.0: first release adding HTTP MCP (qwen.vendor.test.ts), context usage, and system-defaults memory toggle.
  if (installation.via === "executable" && semverAtLeast(version, "0.26.0")) {
    return {
      ...(semverAtLeast(version, "0.26.8") ? { taskEventTypes: ["agent"] } : {}),
      ...(semverAtLeast(version, "0.27.4") ? { subagentResults: { foreground: "parent_tool_result" } } : {}),
      steer: false, images: false, stopTask: false, contextUsage: { tokens: true, contextWindow: true }, mcpTransports: ["stdio", "http"], refusedSessionOptions,
    };
  }
  if (installation.via === "executable" && semverBelow(version, "0.26.0")) {
    return { steer: false, images: false, stopTask: false, mcpTransports: ["stdio"], refusedSessionOptions };
  }
  return { steer: false, images: false, stopTask: false, refusedSessionOptions };
}

export const qwenRuntime = defineRuntime({
  id: "qwen",
  sessionCapabilities: qwenSessionCapabilities,
  manualCompaction: { kind: "unsupported", reason: "stream-json has no structural compaction completion signal and a user compress command can override the native operation." }, brand: runtimeBrands.qwen, verifiedPlatforms: verifiedPlatforms.qwen,
  credentials: qwenCredentials,
  refusedSessionOptions: qwenRefusedSessionOptions,
  resumedSessionOptions: {
    systemPrompt: { provided: "immediate", omitted: "default" },
    appendSystemPrompt: { provided: "immediate", omitted: "default" },
  },
  installation: qwenInstallation,
  skills: onFirstCall(async () => { const { qwenSkills } = await import("./skills.js"); return qwenSkills; }),
  authStatus: Object.assign(onFirstCall(async () => {
    const { qwenAuthStatus } = await import("./auth-status.js");
    return qwenAuthStatus;
  }), { localOnly: true as const }),
  installPlan: qwenInstallPlan,
  install: qwenInstall,
  listModels: onFirstCall(async () => {
    const { qwenListModels } = await import("./list-models.js");
    return qwenListModels;
  }),
  session: onFirstCall(async () => {
    const { qwenSession } = await import("./session.js");
    return qwenSession;
  }),
}, { execution: "process" });
