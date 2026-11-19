import { runtimeBrands } from "../../brands.js";
import { verifiedPlatforms } from "../../platforms.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { opencodeUpgrade } from "./upgrade.js";
import { opencodeInstallation } from "./installation.js";
import { opencodeInstall, opencodeInstallLines, opencodeInstallPlan } from "./install.js";
import { opencodeListModels } from "./list-models.js";
import { opencodeRefusedSessionOptions, opencodeSessionCapabilities } from "./options.js";
import { opencodeSharedRefusal } from "./sharing-admission.js";

export const opencodeRuntime = defineRuntime({
  id: "opencode",
  sessionCapabilities: opencodeSessionCapabilities,
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
