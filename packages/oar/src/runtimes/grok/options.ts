import type { RefusedSessionOptions } from "../../contracts/runtime.js";

/* Declared refusals, apart from the session code so the runtime entry loads no ACP SDK until a session opens. */

export const grokRefusedSessionOptions: RefusedSessionOptions = {
  fork: "OAR has not verified a native Grok fork that opens a copy of a saved session under a new id, cut after a chosen turn",
  goals: "This runtime interface exposes no structured native goal controls",
  userConfiguration: "grok has no verified separation of user configuration from its native login",
  additionalDirectories: "grok ACP exposes no effective additional workspace directory setting",
  serviceTier: "grok exposes no verified per-session service-tier setting and readback",
  name: "grok exposes no verified session name setting",
  disallowedTools: "grok agent stdio does not forward the CLI tool denylist; supplying an agent profile would replace the user's selected harness rather than overlay its tools",
};
