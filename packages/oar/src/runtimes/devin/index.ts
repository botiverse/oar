import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { devinAuthStatus } from "./auth.js";
import { devinInstall, devinInstallPlan } from "./install.js";
import { devinInstallation } from "./installation.js";
import { devinRefusedSessionOptions } from "./options.js";
import { devinCheckUpdate } from "./update.js";

export const devinRuntime = defineRuntime({
  id: "devin",
  sessionCapabilities: () => ({ taskEventTypes: [], steer: false, stopTask: false }),
  manualCompaction: { kind: "unsupported", reason: "Devin CLI ACP exposes no verified manual compaction protocol or structured completion signal." },
  brand: runtimeBrands.devin,
  // Devin 3000.12.57: WINDSURF_API_KEY (DEVIN_API_KEY is ignored) and $XDG_DATA_HOME/devin/credentials.toml (experiments/devin-acp/README.md).
  credentials: {
    scope: "single_account",
    management: "native",
    env: [{ name: "WINDSURF_API_KEY", purpose: "api_key", secret: true, provider: "devin", field: "apiKey" }],
    stores: [
      { kind: "file", directoryEnv: "XDG_DATA_HOME", defaultDirectory: ".local/share", path: "devin/credentials.toml" },
    ],
  },
  installation: devinInstallation,
  installPlan: devinInstallPlan,
  install: devinInstall,
  session: onFirstCall(async () => {
    const { devinSession } = await import("./session.js");
    return devinSession;
  }),
  listModels: onFirstCall(async () => {
    const { devinListModels } = await import("./list-models.js");
    return devinListModels;
  }),
  skills: onFirstCall(async () => { const { devinSkills } = await import("./skills.js"); return devinSkills; }),
  checkUpdate: devinCheckUpdate,
  authStatus: devinAuthStatus,
  refusedSessionOptions: devinRefusedSessionOptions,
}, { execution: "process" });
