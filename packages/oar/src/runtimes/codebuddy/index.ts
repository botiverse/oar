import type { AuthStatusReader } from "../../contracts/login.js";
import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { codebuddyInstallation } from "./installation.js";
import { codebuddyRefusedSessionOptions } from "./options.js";

export const codebuddyRuntime = defineRuntime({
  id: "codebuddy", brand: runtimeBrands.codebuddy,
  refusedSessionOptions: codebuddyRefusedSessionOptions,
  installation: codebuddyInstallation,
  listModels: onFirstCall(async () => { const { codebuddyListModels } = await import("./list-models.js"); return codebuddyListModels; }),
  login: onFirstCall(async () => { const { codebuddyLogin } = await import("./login.js"); return codebuddyLogin; }),
  authStatus: onFirstCall(async (): Promise<AuthStatusReader> => { const { codebuddyAuthStatus } = await import("./auth-status.js"); return codebuddyAuthStatus; }),
  session: onFirstCall(async () => { const { codebuddySession } = await import("./session.js"); return codebuddySession; }),
});
