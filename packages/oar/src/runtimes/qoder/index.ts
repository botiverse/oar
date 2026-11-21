import { semverAtLeast } from "../../shared/semver.js";
import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { qoderInstallation, QODER_MINIMUM_VERSION } from "./installation.js";
import { qoderInstall, qoderInstallPlan } from "./install.js";
import { qoderRefusedSessionOptions } from "./options.js";

export const qoderRuntime = defineRuntime({
  id: "qoder",
  minVersion: QODER_MINIMUM_VERSION,
  sessionCapabilities: (installation) => ({
    ...(installation.via === "executable" && semverAtLeast(installation.version, "1.1.83") ? { taskEventTypes: ["agent"] } : {}),
    steer: true, images: false, contextUsage: { tokens: false, contextWindow: false }, mcpTransports: ["stdio", "http"], stopTask: true,
  }),
  brand: runtimeBrands.qoder, verifiedPlatforms: verifiedPlatforms.qoder,
  // Qoder 1.1.78: QODER_PERSONAL_ACCESS_TOKEN and encrypted *-credentials.json + .keychain-salt under $QODER_HOME (default ~/.qoder).
  credentials: {
    scope: "single_account",
    management: "native",
    signInPaste: "none",
    env: [{ name: "QODER_PERSONAL_ACCESS_TOKEN", purpose: "token", secret: true, provider: "qoder", field: "authToken" }],
    stores: [{ kind: "dir", directoryEnv: "QODER_HOME", defaultDirectory: ".qoder" }],
  },
  manualCompaction: { kind: "supported", activeTurn: "reject" },
  refusedSessionOptions: qoderRefusedSessionOptions,
  installation: qoderInstallation, install: qoderInstall, installPlan: qoderInstallPlan,
  login: onFirstCall(async () => { const { qoderLogin } = await import("./login.js"); return qoderLogin; }),
  authStatus: onFirstCall(async () => { const { qoderAuthStatus } = await import("./auth-status.js"); return qoderAuthStatus; }),
  listModels: onFirstCall(async () => { const { qoderListModels } = await import("./list-models.js"); return qoderListModels; }),
  session: onFirstCall(async () => { const { qoderSession } = await import("./session.js"); return qoderSession; }),
}, { execution: "process" });
