import type { RefusedSessionOptions } from "../../contracts/runtime.js";

export const claudeRefusedSessionOptions: RefusedSessionOptions = {
  goals: "Claude /goal is a prompt command, not a structured native goal control",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted Claude turn's processes while its session stays usable",
};
