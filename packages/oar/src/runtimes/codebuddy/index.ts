import type { AuthStatusReader } from "../../contracts/login.js";
import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { semverAtLeast } from "../../shared/semver.js";
import { codebuddyInstall, codebuddyInstallPlan } from "./install.js";
import { codebuddyInstallation } from "./installation.js";
import { codebuddyRefusedSessionOptions } from "./options.js";

export const codebuddyRuntime = defineRuntime({
  id: "codebuddy",
  sessionCapabilities: (installation) => ({
    steer: false, stopTask: false, contextUsage: { tokens: false, contextWindow: false },
    // 2.178.1: oldest version tested calling stdio/HTTP echo tools in codebuddy.vendor.test.ts (experiments/codebuddy-native/2026-10-29/README.md).
    ...(installation.via === "executable" && semverAtLeast(installation.version, "2.178.1") ? { mcpTransports: ["stdio", "http"] as const } : {}),
  }),
  manualCompaction: { kind: "unsupported", reason: "The published compact method is not implemented by the tested CLI; slash-command completion is unverified." }, brand: runtimeBrands.codebuddy, verifiedPlatforms: verifiedPlatforms.codebuddy,
  // CodeBuddy 2.173.0-2.184.0: CODEBUDDY_CONFIG_DIR moves ~/.codebuddy; CODEBUDDY_AUTH_TOKEN / CODEBUDDY_API_KEY / CODEBUDDY_BASE_URL / CODEBUDDY_INTERNET_ENVIRONMENT.
  credentials: {
    scope: "single_account",
    management: "native",
    signInPaste: "none",
    env: [
      { name: "CODEBUDDY_AUTH_TOKEN", purpose: "token", secret: true, provider: "codebuddy", field: "authToken" },
      { name: "CODEBUDDY_API_KEY", purpose: "api_key", secret: true, provider: "codebuddy", field: "apiKey" },
      { name: "CODEBUDDY_BASE_URL", purpose: "base_url", secret: false, provider: "codebuddy", field: "baseUrl" },
      { name: "CODEBUDDY_INTERNET_ENVIRONMENT", purpose: "account_scope", secret: false, provider: "codebuddy", field: "accountScope" },
    ],
    stores: [
      { kind: "dir", directoryEnv: "CODEBUDDY_CONFIG_DIR", defaultDirectory: ".codebuddy" },
      { kind: "file", directoryEnv: "CODEBUDDY_CONFIG_DIR", defaultDirectory: ".codebuddy", path: "settings.json" },
      { kind: "file", defaultDirectory: ".", path: ".codebuddy.json" },
      { kind: "file", relativeTo: "cwd", path: ".codebuddy/settings.local.json" },
      { kind: "file", relativeTo: "cwd", path: ".codebuddy/settings.json" },
    ],
  },
  refusedSessionOptions: codebuddyRefusedSessionOptions,
  installation: codebuddyInstallation, install: codebuddyInstall, installPlan: codebuddyInstallPlan,
  listModels: onFirstCall(async () => { const { codebuddyListModels } = await import("./list-models.js"); return codebuddyListModels; }),
  login: onFirstCall(async () => { const { codebuddyLogin } = await import("./login.js"); return codebuddyLogin; }),
  authStatus: onFirstCall(async (): Promise<AuthStatusReader> => { const { codebuddyAuthStatus } = await import("./auth-status.js"); return codebuddyAuthStatus; }),
  logout: onFirstCall(async () => { const { codebuddyLogout } = await import("./logout.js"); return codebuddyLogout; }),
  session: onFirstCall(async () => { const { codebuddySession } = await import("./session.js"); return codebuddySession; }),
}, { execution: "process" });
