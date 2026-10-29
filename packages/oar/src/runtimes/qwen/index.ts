import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { qwenInstallation } from "./installation.js";
import { qwenInstall, qwenInstallPlan } from "./install.js";
import { qwenRefusedSessionOptions } from "./options.js";

export { createQwenProviderAuth, QwenProviderAuthError } from "./provider-auth.js";
export type { QwenProvider, QwenProviderAuth, QwenProviderAuthOptions, QwenProviderAuthErrorKind, QwenProviderConnectOptions, QwenProviderConnectResult } from "./provider-auth.js";

export const qwenRuntime = defineRuntime({
  id: "qwen", brand: runtimeBrands.qwen,
  refusedSessionOptions: qwenRefusedSessionOptions,
  installation: qwenInstallation,
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
