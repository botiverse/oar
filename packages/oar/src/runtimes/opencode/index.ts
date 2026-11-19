import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { defineRuntime, type SessionCapabilityDeclaration } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { opencodeUpgrade } from "./upgrade.js";
import { opencodeInstallation } from "./installation.js";
import { opencodeInstall, opencodeInstallLines, opencodeInstallPlan } from "./install.js";
import { opencodeListModels } from "./list-models.js";
import { opencodeRefusedSessionOptions, opencodeV1RefusedSessionOptions } from "./options.js";
import { opencodeSharedRefusal } from "./sharing-admission.js";
import { parseOpencodeRelease } from "./version.js";

export const opencodeRuntime = defineRuntime({
  id: "opencode",
  sessionCapabilities: (installation): SessionCapabilityDeclaration => {
    if (installation.via !== "executable" || installation.version === undefined) { return {}; }
    const major = parseOpencodeRelease(installation.version)?.major;
    if (major === 1) {
      return {
        steer: true, refusedSessionOptions: opencodeV1RefusedSessionOptions,
        manualCompaction: { kind: "unsupported", reason: "OpenCode v1 ACP has no verified structural completion signal for /compact" },
      };
    }
    return major === 2 ? { manualCompaction: { kind: "supported", activeTurn: "reject" } } : {};
  },
  brand: runtimeBrands.opencode, verifiedPlatforms: verifiedPlatforms.opencode,
  refusedSessionOptions: opencodeRefusedSessionOptions,
  mcpToolsListChanged: "full",
  installation: opencodeInstallation,
  upgrade: opencodeUpgrade,
  installPlan: opencodeInstallPlan,
  install: opencodeInstall,
  installLines: opencodeInstallLines,
  session: onFirstCall(async () => {
    const { opencodeSession } = await import("./session.js");
    return opencodeSession;
  }),
  listModels: opencodeListModels,
  skills: onFirstCall(async () => {
    const { opencodeSkills } = await import("./skills.js");
    return opencodeSkills;
  }),
}, { execution: "process", shared: {
  refusal: opencodeSharedRefusal,
  session: () => onFirstCall(async () => {
    const { createOpenCodeSharedSession } = await import("./shared-session.js");
    return createOpenCodeSharedSession();
  }),
} });

export { createOpencodeProviderAuth, OpencodeProviderAuthError } from "./provider-auth.js";
export type { OpencodeProviderAuth, OpencodeProviderAuthErrorKind, OpencodeProviderAuthOptions } from "./provider-auth.js";
