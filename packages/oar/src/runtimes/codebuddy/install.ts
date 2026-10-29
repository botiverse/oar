import { planInstaller } from "../../shared/install.js";
import { npmInstallPlan, type NpmInstallMethod } from "../../shared/install-npm.js";
import { codebuddyInstallation } from "./installation.js";

/** The documented stable method; the native script remains a vendor Beta. */
export const codebuddyInstallMethod: NpmInstallMethod = {
  packageName: "@tencent-ai/codebuddy-code",
  source: "https://www.codebuddy.ai/docs/cli/installation",
};

export const codebuddyInstallPlan = npmInstallPlan(codebuddyInstallMethod);
export const codebuddyInstall = planInstaller(codebuddyInstallation, codebuddyInstallPlan);
