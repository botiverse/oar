import type { ControlOutcome, DeliverOptions, DeliverResult, InputOptions, Session } from "../contracts/session.js";
import { awaitIdle } from "../observe/turns.js";

/** Attempts across prompt / steer / queue races before reporting the last refusal. */
const MAX_ATTEMPTS = 4;


function landed(kind: "prompted" | "steered" | "queued", inputId: string, result: ControlOutcome): DeliverResult {
  return { landed: kind, inputId, result };
}

function refused(inputId: string, result: ControlOutcome): DeliverResult {
  return result.kind === "rejected"
    ? { landed: "rejected", inputId, code: result.code, reason: result.reason, result }
    : { landed: "rejected", inputId, code: "unsupported", reason: "accepted", result };
}

/** One attempt into a running turn; null when the turn ended meanwhile (try again). */
async function intoRunning(session: Session, input: string, options: InputOptions & { readonly inputId: string }, when: "now" | "after_turn"): Promise<DeliverResult | null> {
  if (when === "now") {
    const steered = await session.steer(input, options);
    if (steered.kind === "accepted") {
      return landed("steered", options.inputId, steered);
    }
    if (steered.code === "no_active_turn") {
      return null;
    }
    if (steered.code !== "unsupported") {
      return refused(options.inputId, steered);
    }
  }
  if (session.capabilities.queue === null) {
    // Nothing holds input for a later turn here: hold it ourselves until the turn ends.
    await awaitIdle(session);
    return null;
  }
  const queued = await session.queue(input, options);
  return queued.kind === "accepted" ? landed("queued", options.inputId, queued) : refused(options.inputId, queued);
}

/** `Session.deliver`, derived from the session's own controls and status. */
export async function deliverInto(session: Session, input: string, options: DeliverOptions & { readonly inputId: string }): Promise<DeliverResult> {
  const { when = "now", ...inputOptions } = options;
  let last: ControlOutcome | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (when === "when_idle") {
      await awaitIdle(session);
    }
    if (session.status().value.kind === "idle") {
      last = await session.prompt(input, inputOptions);
      if (last.kind === "accepted") {
        return landed("prompted", options.inputId, last);
      }
      if (last.code !== "busy") {
        return refused(options.inputId, last);
      }
      // A turn opened between the status read and the prompt: deliver into it.
    }
    if (when !== "when_idle") {
      const result = await intoRunning(session, input, inputOptions, when);
      if (result !== null) {
        return result;
      }
    }
  }
  return last === null
    ? { landed: "rejected", inputId: options.inputId, code: "busy", reason: "the session kept changing state; nothing was delivered" }
    : refused(options.inputId, last);
}
