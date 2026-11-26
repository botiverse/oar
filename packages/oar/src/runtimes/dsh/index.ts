import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { semverAtLeast } from "../../shared/semver.js";
import { dshInstallation } from "./installation.js";
import { dshInstall, dshInstallPlan } from "./install.js";
import { dshDirectoryRefusal, dshRefusedSessionOptions, dshSessionLogUploadRefusal, dshSupportsNativeSessionFile } from "./options.js";
import { DSH_MINIMUM_VERSION } from "./version.js";

export const dshRuntime = defineRuntime({
  id: "dsh",
  manualCompaction: { kind: "supported", activeTurn: "reject" },
  sessionCapabilities: (installation) => {
    const version = installation.via === "executable" ? installation.version : undefined;
    const nativeSessionFile = dshSupportsNativeSessionFile(version);
    return {
      ...(nativeSessionFile === undefined ? {} : { nativeSessionFile }),
      ...(semverAtLeast(version, DSH_MINIMUM_VERSION) ? { taskEventTypes: ["agent", "shell"], dshProvider: true } : {}),
      // The session still checks the selected model and the native attachment store at open.
      ...(semverAtLeast(version, "0.2.2-rc.2") ? { images: true } : {}),
      ...(semverAtLeast(version, "0.2.2-rc.5") ? { subagentResults: { background: "child_text" } } : {}),
      compactionEvents: { started: true, ended: true },
      contextUsage: { tokens: true, contextWindow: true },
      mcpTransports: ["stdio", "http"],
      stopTask: true,
      refusedSessionOptions: { ...dshDirectoryRefusal(version), ...dshSessionLogUploadRefusal(version) },
    };
  }, brand: runtimeBrands.dsh, verifiedPlatforms: verifiedPlatforms.dsh,
  minVersion: DSH_MINIMUM_VERSION,
  // The default route reads DEEPSEEK_API_KEY; a key saved through DSH's own settings wins (docs/runtimes/dsh.md#credentials).
  credentials: {
    scope: "single_account",
    management: "external",
    env: [{ name: "DEEPSEEK_API_KEY", purpose: "api_key", secret: true, provider: "deepseek", field: "apiKey" }],
    stores: [
      { kind: "file", directoryEnv: "DSH_HOME", defaultDirectory: ".dsh", path: ".credentials.yaml", overridesEnv: true },
      { kind: "file", relativeTo: "cwd", path: ".env", overridesEnv: false },
      { kind: "file", directoryEnv: "DSH_HOME", defaultDirectory: ".dsh", path: ".env", overridesEnv: false },
    ],
  },
  refusedSessionOptions: dshRefusedSessionOptions,
  resumedSessionOptions: {
    systemPrompt: { provided: "immediate", omitted: "default" },
    appendSystemPrompt: { provided: "immediate", omitted: "default" },
  },
  installation: dshInstallation, install: dshInstall, installPlan: dshInstallPlan,
  listModels: onFirstCall(async () => { const { dshListModels } = await import("./list-models.js"); return dshListModels; }),
  skills: onFirstCall(async () => { const { dshSkills } = await import("./skills.js"); return dshSkills; }),
  session: onFirstCall(async () => { const { dshSession } = await import("./session.js"); return dshSession; }),
}, { execution: "process" });
