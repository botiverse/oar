import type { RuntimeDefinition } from "../definition.js";
import { codexDriver } from "../../discovery/host/drivers/codex.js";
import { codexInstallAttempts } from "../../discovery/host/codexInstall.js";

const codexRuntimeDefinition: RuntimeDefinition = {
  id: "codex",
  install: { attempts: codexInstallAttempts },
  createDriver: codexDriver,
};

export default codexRuntimeDefinition;
