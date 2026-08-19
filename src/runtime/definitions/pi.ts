import type { RuntimeDefinition } from "../definition.js";
import { piDriver } from "../../discovery/host/drivers/pi.js";
import { resolvePiSdkVersion } from "../../discovery/host/piSdkResolution.js";
import { sdkAttempts } from "../../discovery/install/attempts.js";

const piRuntimeDefinition: RuntimeDefinition = {
  id: "pi",
  install: { attempts: () => sdkAttempts(resolvePiSdkVersion) },
  createDriver: piDriver,
};

export default piRuntimeDefinition;
