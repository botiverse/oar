import type { ControlOutcome, DeliverOptions, DeliverResult, InputOptions, Session } from "../contracts/session.js";
import { interruptInto, pendingInterrupt } from "./deliver-interrupt.js";
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

/** The running turn's start, or null when the session is idle. */
function runningSince(session: Session): number | null {
  const status = session.status().value;
  return status.kind === "running" ? status.sinceSeq : null;
}

/** One attempt into a running turn; null when the turn ended meanwhile (try again). */
async function intoRunning(session: Session, input: string, options: InputOptions & { readonly inputId: string }, when: "now" | "after_turn"): Promise<DeliverResult | null> {
  // A session without `steer` cannot inject: the input goes straight to the queue.
  if (when === "now" && session.steer !== undefined) {
    const target = runningSince(session);
    const steered = await session.steer(input, options);
    if (steered.kind === "accepted") {
      return landed("steered", options.inputId, steered);
    }
    // The turn ended while the steer was in flight. The adapter's gate says
    // `no_active_turn`; past the gate the runtime refuses in its own words
    // (codex 0.158.0: "no active turn to steer"), so read the status too.
    if (steered.code === "no_active_turn" || runningSince(session) !== target) {
      return null;
    }
    // A steer that cannot take these inputs (images on a cursor steer) still queues.
    if (steered.code !== "unsupported") {
      return refused(options.inputId, steered);
    }
  }
  const queued = await session.queue(input, options);
  return queued.kind === "accepted" ? landed("queued", options.inputId, queued) : refused(options.inputId, queued);
}

/** `Session.deliver`, derived from the session's own controls and status. */
export async function deliverInto(session: Session, input: string, options: DeliverOptions & { readonly inputId: string }): Promise<DeliverResult> {
  if (options.when === "interrupt" && (!Number.isFinite(options.maxWaitMs) || options.maxWaitMs < 0)) {
    throw new RangeError("interrupt maxWaitMs must be finite and nonnegative");
  }
  const pending = pendingInterrupt(session);
  if (pending !== undefined) {
    if (options.when === "interrupt" && pending.accepting()) { return pending.join(input, options); }
    await pending.done;
    return deliverInto(session, input, options);
  }
  const { when = "now", maxWaitMs: _wait, merge: _merge, ...inputOptions } = options;
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
      if (options.when === "interrupt" && session.steer === undefined) {
        return interruptInto(session, input, options);
      }
      const result = await intoRunning(session, input, inputOptions, when === "interrupt" ? "now" : when);
      if (result !== null) {
        return result;
      }
    }
  }
  return last === null
    ? { landed: "rejected", inputId: options.inputId, code: "busy", reason: "the session kept changing state; nothing was delivered" }
    : refused(options.inputId, last);
}
