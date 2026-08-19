import type { RuntimeDefinition } from "../definition.js";
import { claudeDriver } from "../../discovery/host/drivers/claude.js";
import { claudeInstallAttempts } from "../../discovery/host/claudeInstall.js";

const claudeRuntimeDefinition: RuntimeDefinition = {
  id: "claude",
  install: { attempts: claudeInstallAttempts },
  createDriver: claudeDriver,
};

export default claudeRuntimeDefinition;
