import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { SessionOptions } from "../../contracts/session.js";

/** Each stays refused until `bottega serve` carries it and a test here shows it applied (docs/runtimes/bottega.md). */
export const bottegaRefusedSessionOptions: RefusedSessionOptions = {
  systemPrompt: "bottega's system prompt says how to read the screen its apps draw; a host's standing text goes after it, as appendSystemPrompt",
  mcpServers: "bottega takes an MCP server as an installed app; attaching one to a single session through serve is not built",
  disallowedTools: "bottega's tools are its apps' actions; a per-session denial through serve is not built",
  launchArgs: "OAR owns bottega's launch (`bottega serve`); arbitrary flags are not verified",
  serviceTier: "bottega has no per-session service-tier setting",
  additionalDirectories: "a bottega session works in one directory; more are not verified",
  outputSchema: "bottega has no final-output schema channel",
  name: "a bottega session is named by its id; no other name is set through serve",
  userConfiguration: "bottega reads its settings and installed apps from its home; a session without them is not verified",
  goals: "This runtime interface exposes no structured native goal controls",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted bottega turn's processes while its session stays usable",
  fork: "bottega serve has no fork: a copy of a saved session under a new id, cut after a chosen turn, is not built",
  nativeMemoryDefault: "bottega has no background auto-memory and no below-user default layer for one",
  sessionLogUpload: "This adapter has no verified switch to stop vendor session-log upload",
  nativePermissions: "bottega asks no approvals and has no permission or sandbox settings for a session to inherit",
  modelRequests: "bottega serve reports no provider request; this adapter has none to keep",
  userQuestions: "bottega's agent asks through the conversation, not a question a host answers",
};

/** bottega's reasoning levels, in its own spelling (bottega/src/runtime.ts). */
export const BOTTEGA_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface BottegaOpenFields {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly instructions?: string;
}

/**
 * What `open` and `resume` carry of the session options. bottega routes a
 * request by provider and model, so `model` is `provider/model` (the model id
 * may hold more slashes, as OpenRouter's do); a bare name has no route. A
 * level outside bottega's spelling is refused here; one the model cannot run
 * is refused by bottega (`unsupported_thinking`).
 */
export function bottegaOpenFields(options: Pick<SessionOptions, "model" | "effort" | "appendSystemPrompt">): BottegaOpenFields {
  const { model, effort, appendSystemPrompt } = options;
  const fields: { provider?: string; model?: string; thinking?: string; instructions?: string } = {};
  if (model !== undefined) {
    const separator = model.indexOf("/");
    if (separator <= 0 || separator === model.length - 1) {
      throw new UnsupportedOptionError("model", `bottega selects a model as provider/model, not ${JSON.stringify(model)}`);
    }
    fields.provider = model.slice(0, separator);
    fields.model = model.slice(separator + 1);
  }
  if (effort !== undefined) {
    if (!BOTTEGA_THINKING_LEVELS.some((level) => level === effort)) {
      throw new UnsupportedOptionError("effort", `bottega has no reasoning level ${JSON.stringify(effort)}; its levels are ${BOTTEGA_THINKING_LEVELS.join(", ")}`);
    }
    fields.thinking = effort;
  }
  if (appendSystemPrompt !== undefined) { fields.instructions = appendSystemPrompt; }
  return fields;
}
