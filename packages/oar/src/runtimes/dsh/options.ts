import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { SessionOptions } from "../../contracts/session.js";

/** Each stays refused until its own native probe. DSH may well have the concept; OAR has not verified its semantics. */
export const dshRefusedSessionOptions: RefusedSessionOptions = {
  fork: "OAR has not verified a native DSH fork that opens a copy of a saved session under a new id, cut after a chosen turn",
  mcpServerCredentials: "DSH MCP env and header persistence has not been audited; only stdio command and args are supported",
  launchArgs: "DSH overlays can disable the OAR bridge; arbitrary launch overlays have no verified final-composition check",
  serviceTier: "DSH has no verified per-session service-tier setting and readback",
  additionalDirectories: "DSH 0.2.1 lacks extra writable roots; newer overlays replace the whole sandbox policy, and preserving its effective settings is not verified",
  outputSchema: "DSH has no verified final-output schema channel",
  userConfiguration: "DSH default-config dumping omits provider routes with user patches; no verified boot filter preserves providers, login and history",
  endTurnProcessesOnAbort: "DSH cancellation leaves background jobs alive; selected Linux jobs can be killed natively, but complete per-turn process cleanup is not verified",
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
