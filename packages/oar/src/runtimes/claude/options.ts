import type { RefusedSessionOptions } from "../../contracts/runtime.js";

export const claudeMcpCredentialRefusal = "OAR has not verified that Claude reads a regular-file MCP configuration only at startup";

export const claudeRefusedSessionOptions: RefusedSessionOptions = {
  ...(process.platform === "win32" ? { mcpServerCredentials: claudeMcpCredentialRefusal } : {}),
  goals: "Claude /goal is a prompt command, not a structured native goal control",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Claude turn's processes while its session stays usable",
  nativeMemoryDefault: "Claude Code has no configuration layer below user settings for a soft native-memory default",
};
