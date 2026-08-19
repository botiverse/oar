import type { RuntimeDefinition } from "../definition.js";
import { kimiCliDriver } from "../../discovery/host/drivers/kimiCli.js";
import { kimiCliInstallAttempts } from "../../discovery/host/kimiCliInstall.js";

const kimiCliRuntimeDefinition: RuntimeDefinition = {
  id: "kimi-cli",
  install: { attempts: kimiCliInstallAttempts },
  createDriver: kimiCliDriver,
};

export default kimiCliRuntimeDefinition;
