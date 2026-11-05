import { planInstaller } from "../../shared/install.js";
import { npmInstallPlan, type NpmInstallMethod } from "../../shared/install-npm.js";
import { dshInstallation } from "./installation.js";

/** The package DSH publishes; npm's own tag selects the version and `installation` judges the result against the floor. */
export const dshInstallMethod: NpmInstallMethod = {
  packageName: "@deepseek-ai/dsh",
  source: "https://www.npmjs.com/package/@deepseek-ai/dsh",
};

export const dshInstallPlan = npmInstallPlan(dshInstallMethod);
export const dshInstall = planInstaller(dshInstallation, dshInstallPlan);
