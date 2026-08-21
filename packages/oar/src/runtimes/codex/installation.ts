import os from "node:os";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

// The macOS Desktop app bundles the Codex CLI instead of putting it on PATH.
// OpenAI relocated the app from Codex.app to ChatGPT.app, so the new bundle is
// tried before the legacy one, and system installs before per-user installs.
const desktopBundles = process.platform === "darwin"
  ? [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      path.join(os.homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
      path.join(os.homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex"),
    ]
  : [];

// OAR drives Codex through its app-server surface; a codex without it is unsupported.
export const codexInstallation = executableInstallation(
  "OAR_CODEX_BIN",
  "codex",
  desktopBundles,
  ["app-server", "--help"],
);
