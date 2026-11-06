import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { SessionOptions } from "../../contracts/session.js";

/** Each stays refused until its own native probe. DSH may well have the concept; OAR has not verified its semantics. */
export const dshRefusedSessionOptions: RefusedSessionOptions = {
  systemPrompt: "DSH's system prompt replacement through this bridge has not been verified",
  appendSystemPrompt: "DSH's appended system prompt through this bridge has not been verified",
  mcpServerCredentials: "DSH MCP env and header persistence has not been audited; only stdio command and args are supported",
  disallowedTools: "DSH's per-session tool denial through this bridge has not been verified",
  launchArgs: "OAR owns DSH's launcher arguments and bridge overlay; arbitrary flags have not been verified",
  serviceTier: "DSH has no verified per-session service-tier setting and readback",
  additionalDirectories: "DSH has no verified effective additional workspace directory channel",
  outputSchema: "DSH has no verified final-output schema channel",
  name: "DSH has no verified session name setting",
  userConfiguration: "DSH has no verified way to exclude user configuration while keeping its provider routes",
  goals: "This runtime interface exposes no verified structured native goal controls",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted DSH turn's processes while its session stays usable",
};

export interface DshAgentOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

/** DSH routes every request by provider and model; a bare model name has no route and would fail only at its first request. */
export function dshAgentOptions(options: Pick<SessionOptions, "model" | "effort">): DshAgentOptions {
  const { model, effort } = options;
  const effortOption = effort === undefined ? {} : { reasoningEffort: effort };
  if (model === undefined) { return effortOption; }
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new UnsupportedOptionError("model", `DSH selects a model as provider/model, not ${JSON.stringify(model)}`);
  }
  return { provider: model.slice(0, separator), model: model.slice(separator + 1), ...effortOption };
}
