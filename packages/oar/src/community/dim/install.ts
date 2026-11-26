import { planInstaller } from "../../shared/install.js";
import { npmInstallPlan, type NpmInstallMethod } from "../../shared/install-npm.js";
import { dimInstallation } from "./installation.js";

/** The documented install of the Rust alpha; its `latest` dist-tag is the alpha and its only bin is `dima`. */
export const dimInstallMethod: NpmInstallMethod = {
  packageName: "dimcode-alpha",
  source: "https://github.com/arcships/dim#install",
};

export const dimInstallPlan = npmInstallPlan(dimInstallMethod);
export const dimInstall = planInstaller(dimInstallation, dimInstallPlan);
