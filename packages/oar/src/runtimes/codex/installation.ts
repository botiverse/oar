import os from "node:os";
import path from "node:path";
import type { Installation } from "../../contracts/installation.js";
import { probeExecutableInstallation } from "../../shared/installation.js";

function candidates(): readonly string[] {
  const explicit = process.env.OAR_CODEX_BIN;
  if (explicit !== undefined && explicit !== "") {
    return [explicit];
  }
  if (process.platform !== "darwin") {
    return ["codex"];
  }
  // Codex Desktop bundles its CLI inside the macOS app instead of putting it on PATH.
  return [
    "codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    path.join(os.homedir(), ".codex", "plugins", ".plugin-appserver", "codex"),
  ];
}

export const codexInstallation: Installation = {
  // OAR drives Codex through its app-server surface; a codex without it is unsupported.
  async probe() {
    const snapshot = await probeExecutableInstallation(candidates(), {
      args: ["app-server", "--help"],
      unsupportedReason: "app_server_unavailable",
    });
    return snapshot;
  },
};
