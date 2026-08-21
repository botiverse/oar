import { createExecutableInstallation } from "../../installation.js";

export const claudeInstallation = createExecutableInstallation({
  label: "Claude",
  command: "claude",
  explicit: process.env.CLAUDE_BIN,
});
