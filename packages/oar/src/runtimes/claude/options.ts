import type { RefusedSessionOptions } from "../../contracts/runtime.js";

export const claudeRefusedSessionOptions: RefusedSessionOptions = {
  goals: "Claude /goal is a prompt command, not a structured native goal control",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Claude turn's processes while its session stays usable",
  nativeMemoryDefault: "Claude Code has no settings layer below user/project settings; both CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 and --settings override explicit user autoMemoryEnabled settings. To hard-disable auto-memory, use userConfiguration: { exclude: [\"instructions\"] }",
};
