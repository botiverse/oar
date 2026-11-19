import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { opencodeInstallation } from "./installation.js";
import { opencodeInstall, opencodeInstallLines, opencodeInstallPlan } from "./install.js";
import { opencodeListModels } from "./list-models.js";
import { opencodeRefusedSessionOptions } from "./options.js";
import { opencodeSharedRefusal } from "./sharing-admission.js";
import { parseOpencodeRelease } from "./version.js";

export const opencodeRuntime = defineRuntime({
  id: "opencode",
  // v1 always steers; v2 steers only when initialize advertises it. Images come from initialize.
  sessionCapabilities: (installation) => (installation.via === "executable" && installation.version !== undefined && parseOpencodeRelease(installation.version)?.major === 1 ? { steer: true } : {}),
  brand: runtimeBrands.opencode, verifiedPlatforms: verifiedPlatforms.opencode,
  refusedSessionOptions: opencodeRefusedSessionOptions,
  mcpToolsListChanged: "full",
  installation: opencodeInstallation,
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
