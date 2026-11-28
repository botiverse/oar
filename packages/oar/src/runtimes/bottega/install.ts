import { planInstaller } from "../../shared/install.js";
import { npmInstallPlan, type NpmInstallMethod } from "../../shared/install-npm.js";
import { bottegaInstallation, BOTTEGA_PACKAGE } from "./installation.js";

/** The package bottega publishes, installed globally for `bottega` on PATH; `installation` judges the result against the floor. */
export const bottegaInstallMethod: NpmInstallMethod = {
  packageName: BOTTEGA_PACKAGE,
  source: "https://www.npmjs.com/package/@botiverse/bottega",
};

export const bottegaInstallPlan = npmInstallPlan(bottegaInstallMethod);
export const bottegaInstall = planInstaller(bottegaInstallation, bottegaInstallPlan);
