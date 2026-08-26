import { executableInstallation } from "../../shared/installation.js";

export const grokInstallation = executableInstallation(
  "OAR_GROK_BIN",
  "grok",
  [],
  ["agent", "stdio", "--help"],
);
