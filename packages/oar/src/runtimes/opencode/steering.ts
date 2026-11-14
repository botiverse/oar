import type { AcpSessionProfile } from "../../shared/acp/profile.js";
import { asRecord } from "../../shared/json.js";

/**
 * OpenCode v2's interim mid-turn steering extension (first in 2.2.7; source
 * `packages/cli/src/acp/{agent,turn,service}.ts`, docs/runtimes/opencode.md).
 * `initialize` advertises it as `_meta.steering.supported: true`. The agent
 * answers `injected` after adding the input to the running native turn, or
 * `promptRequired` / `noRunningTurn` without starting a turn when none runs.
 */
export const OPENCODE_STEERING = "_session/steering";

export const opencodeSteering: Pick<AcpSessionProfile, "steerRequest" | "steerRequestAdvertised" | "steerRequestAnswer"> = {
  // The extension reads only `sessionId` and `prompt`; it has no input identity field.
  steerRequest: ({ sessionId, prompt }) => ({ method: OPENCODE_STEERING, params: { sessionId, prompt } }),
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP metadata envelope.
  steerRequestAdvertised: (initialized) => asRecord(asRecord(initialized._meta)?.steering)?.supported === true,
  steerRequestAnswer: (answer) => {
    const outcome = asRecord(answer)?.outcome;
    if (outcome === "injected") { return "accepted"; }
    return outcome === "promptRequired" ? "no_active_turn" : null;
  },
};
