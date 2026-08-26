import { executableInstallation } from "../../shared/installation.js";

export const kimiInstallation = executableInstallation(
  "OAR_KIMI_BIN",
  "kimi",
  ["kimi-code"],
  ["acp", "--help"],
  { readinessTimeoutMs: 30_000, versionTimeoutMs: 30_000 },
);
