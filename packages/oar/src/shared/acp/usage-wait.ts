import type { ContextUsage } from "../../contracts/session.js";
import type { AcpSessionProfile } from "./profile.js";

/**
 * Bridges the gap between an agent's `session/prompt` answer and the
 * `usage_update` it pushes afterwards.
 *
 * kimi-code f9ca33376 packages/acp-server/src/session.ts `onTurnEnded`
 * (lines 907-921) resolves the prompt response and then calls
 * `void this.emitUsageUpdate()` (lines 923-945), which awaits
 * `kosong.listModels()` and `agent.getContext()` before notifying, and returns
 * without a push when the catalog has no `max_context_size` for the current
 * model. Settling the OAR turn on the response alone therefore leaves
 * `contextUsage()` at the PREVIOUS turn's value at `turn_ended`, and there is
 * no guarantee an update ever comes — hence a bounded wait, not a barrier.
 */
export interface UsageUpdateGate {
  /** Forget any update seen so far; call before sending the prompt. */
  readonly arm: () => void;
  /** Feed every projected update; only a present usage counts as arrival. */
  readonly observe: (usage: ContextUsage | undefined) => void;
  /**
   * After the prompt response: resolve once a usage_update arrived since
   * `arm()`, or after the profile's bound. Immediate when the profile does not
   * declare the late push or the turn is being aborted.
   */
  readonly settleAfterPrompt: (
    profile: Pick<AcpSessionProfile, "usageUpdateAfterPrompt" | "usageUpdateTimeoutMs">,
    aborting: boolean,
  ) => Promise<void>;
}

export const DEFAULT_USAGE_UPDATE_TIMEOUT_MS = 500;

export function createUsageUpdateGate(): UsageUpdateGate {
  let seen = false;
  let release: (() => void) | null = null;
  return {
    arm: (): void => {
      seen = false;
    },
    observe: (usage): void => {
      if (usage === undefined) {
        return;
      }
      seen = true;
      release?.();
    },
    settleAfterPrompt: async (profile, aborting): Promise<void> => {
      if (profile.usageUpdateAfterPrompt !== true || aborting || seen) {
        return;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, profile.usageUpdateTimeoutMs ?? DEFAULT_USAGE_UPDATE_TIMEOUT_MS);
      timer.unref();
      release = resolve;
      try {
        await promise;
      } finally {
        clearTimeout(timer);
        release = null;
      }
    },
  };
}
