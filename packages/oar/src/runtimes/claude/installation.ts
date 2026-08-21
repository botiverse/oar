import type { Installation } from "../../contracts/installation.js";
import { probeExecutableInstallation } from "../../shared/installation.js";

export const claudeInstallation: Installation = {
  async probe() {
    const explicit = process.env.OAR_CLAUDE_BIN;
    const snapshot = await probeExecutableInstallation([
      explicit === undefined || explicit === "" ? "claude" : explicit,
    ]);
    return snapshot;
  },
};
