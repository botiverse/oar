import type { AuthStatusReader } from "../../contracts/login.js";
import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { codebuddyInstall, codebuddyInstallPlan } from "./install.js";
import { codebuddyInstallation } from "./installation.js";
import { codebuddyRefusedSessionOptions } from "./options.js";

export const codebuddyRuntime = defineRuntime({
  id: "codebuddy",
  manualCompaction: { kind: "unsupported", reason: "The published compact method is not implemented by the tested CLI; slash-command completion is unverified." }, brand: runtimeBrands.codebuddy,
  refusedSessionOptions: codebuddyRefusedSessionOptions,
  installation: codebuddyInstallation, install: codebuddyInstall, installPlan: codebuddyInstallPlan,
  listModels: onFirstCall(async () => { const { codebuddyListModels } = await import("./list-models.js"); return codebuddyListModels; }),
  login: onFirstCall(async () => { const { codebuddyLogin } = await import("./login.js"); return codebuddyLogin; }),
  authStatus: onFirstCall(async (): Promise<AuthStatusReader> => { const { codebuddyAuthStatus } = await import("./auth-status.js"); return codebuddyAuthStatus; }),
  logout: onFirstCall(async () => { const { codebuddyLogout } = await import("./logout.js"); return codebuddyLogout; }),
  session: onFirstCall(async () => { const { codebuddySession } = await import("./session.js"); return codebuddySession; }),
}, { execution: "process" });
