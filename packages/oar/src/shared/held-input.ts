import type { ControlResult, ResponseBody } from "../contracts/session.js";
import type { SessionKernel } from "./session-kernel.js";

/** An input an adapter holds for a later turn, found again by the `inputId` its queue request carried. */
export interface HeldInput {
  readonly inputId?: string | undefined;
}

/**
 * The decision of `Session.withdraw` over an adapter-held queue: remove every
 * entry held for `inputId` and answer `accepted`, or answer `not_queued` when
 * none is waiting (already sent, never queued in this session, or already
 * withdrawn). Synchronous on purpose, and called synchronously from the
 * withdraw's `kernel.control` decision: the adapter's drain takes an entry
 * off the same array in one step before it sends it, so a withdraw either
 * removes the entry before the drain reaches it or finds it gone. It never
 * accepts an input that may already have been sent.
 */
export function withdrawHeld(held: HeldInput[], inputId: string): ResponseBody {
  const before = held.length;
  for (let index = held.length - 1; index >= 0; index -= 1) {
    if (held[index]?.inputId === inputId) {
      held.splice(index, 1);
    }
  }
  return held.length < before
    ? { kind: "accepted" }
    : { kind: "rejected", code: "not_queued", reason: "no held input with this inputId is waiting" };
}

/**
 * The `withdraw` member of an adapter that holds its queue in `held`: the
 * request is recorded through `kernel.control`, so a disposed or exited
 * session answers `disposed` / `runtime_exited` before `withdrawHeld` runs.
 */
export function withdrawControl(kernel: SessionKernel, held: HeldInput[]): (inputId: string) => Promise<ControlResult> {
  return async (inputId) => {
    const result = await kernel.control({ kind: "withdraw", inputId }, () => withdrawHeld(held, inputId));
    return result;
  };
}
