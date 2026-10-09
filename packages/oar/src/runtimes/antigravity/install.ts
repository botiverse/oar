import { planInstaller, unsupportedInstallPlan } from "../../shared/install.js";
import { antigravityInstallation } from "./installation.js";

/**
 * Google documents installing the Antigravity agent only from inside an
 * editor (Zed: agent settings, External Agents, Install from Registry;
 * https://antigravity.google/docs/ide/extensions/zed), which also signs it in
 * through the browser. There is no command-line installer: the ACP registry's
 * zip is what the editor unpacks.
 */
export const antigravityInstallPlan = unsupportedInstallPlan({
  kind: "unsupported",
  reason: "requires_gui",
  detail: "Google installs the Antigravity agent from an editor's agent registry (Zed: External Agents, Install from Registry); https://antigravity.google/docs/ide/extensions/zed",
});

export const antigravityInstall = planInstaller(antigravityInstallation, antigravityInstallPlan);
