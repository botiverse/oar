import type { RuntimeDefinition } from "../definition.js";
import { kimiDriver } from "../../discovery/host/drivers/kimiSdk.js";
import { resolveKimiSdkVersion } from "../../discovery/host/kimiSdkResolution.js";
import { sdkAttempts } from "../../discovery/install/attempts.js";

const kimiSdkRuntimeDefinition: RuntimeDefinition = {
  id: "kimi",
  install: { attempts: () => sdkAttempts(resolveKimiSdkVersion) },
  createDriver: kimiDriver,
};

export default kimiSdkRuntimeDefinition;
