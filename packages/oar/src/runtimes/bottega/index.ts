import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { bottegaCredentials } from "./credentials.js";
import { bottegaInstallation } from "./installation.js";
import { bottegaInstall, bottegaInstallPlan } from "./install.js";
import { bottegaRefusedSessionOptions } from "./options.js";
import { bottegaCheckUpdate } from "./update.js";
import { BOTTEGA_MINIMUM_VERSION } from "./version.js";

/**
 * bottega, an agent whose state lives in apps and whose context is a screen of
 * their windows, driven through `bottega serve` (docs/runtimes/bottega.md). It
 * runs from the optional dependency `@botiverse/bottega` under this Node, or
 * from `bottega` on PATH or `OAR_BOTTEGA_BIN`.
 */
export const bottegaRuntime = defineRuntime({
  id: "bottega",
  sessionCapabilities: () => ({ steer: true, images: false, contextUsage: { tokens: true, contextWindow: true } }),
  brand: runtimeBrands.bottega,
  minVersion: BOTTEGA_MINIMUM_VERSION,
  credentials: bottegaCredentials,
  refusedSessionOptions: bottegaRefusedSessionOptions,
  manualCompaction: { kind: "unsupported", reason: "bottega repaints its screen itself when a step's cost calls for it; serve has no command to ask for one." },
  // `resume` replaces the appended text and the reasoning level it is given and keeps the saved ones otherwise.
  resumedSessionOptions: {
    appendSystemPrompt: { provided: "immediate", omitted: "saved" },
    effort: { provided: "immediate", omitted: "saved" },
  },
  installation: bottegaInstallation, install: bottegaInstall, installPlan: bottegaInstallPlan,
  checkUpdate: bottegaCheckUpdate,
  listModels: onFirstCall(async () => { const { bottegaListModels } = await import("./list-models.js"); return bottegaListModels; }),
  session: onFirstCall(async () => { const { bottegaSession } = await import("./session.js"); return bottegaSession; }),
}, { execution: "process" });

export { BOTTEGA_SERVE_PROTOCOL } from "./control.js";
export { BOTTEGA_THINKING_LEVELS } from "./options.js";
