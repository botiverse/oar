import os from "node:os";
import path from "node:path";
import { createExecutableInstallation } from "../../installation.js";

export const codexInstallation = createExecutableInstallation({
  label: "Codex",
  command: "codex",
  explicit: process.env.CODEX_BIN,
  fallbacks: process.platform === "darwin"
    ? [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        path.join(os.homedir(), ".codex", "plugins", ".plugin-appserver", "codex"),
      ]
    : [],
  readiness: {
    args: ["app-server", "--help"],
    unsupportedReason: "app_server_unavailable",
  },
});
