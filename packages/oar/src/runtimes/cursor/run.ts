import type { ResponseBody } from "../../contracts/session.js";
import { cursorRunFailedFrame, cursorRunResultFrame, cursorStreamFrame, type CursorFrame } from "./projection.js";
import type { CursorRun, SteerAckOutcome } from "./sdk.js";

export interface ActiveRun {
  readonly run: CursorRun;
  /** Settles once the run's end is in the stream. */
  readonly ended: Promise<void>;
}

/**
 * One `send` on its way to a run. The prompt's answer waits on `decided`;
 * an abort that arrives first is held in `abortRequested`; a dispose or the
 * send deadline gives the launch up, and a run the SDK returns after that is
 * stopped rather than adopted. Each launch is its own object, so a later one
 * never reads or clears an earlier one's state.
 */
export interface Launch {
  state: "sending" | "sent" | "failed" | "given_up";
  abortRequested: boolean;
  current: ActiveRun | null;
  /** Why it was not sent: the SDK's error, or the reason it was given up. */
  reason: string;
  readonly decided: Promise<void>;
  readonly decide: () => void;
}

export function newLaunch(): Launch {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { state: "sending", abortRequested: false, current: null, reason: "", decided: promise, decide: resolve };
}

export function giveUp(launch: Launch, reason: string): void {
  if (launch.state === "sending") {
    launch.state = "given_up";
    launch.reason = reason;
    launch.decide();
  }
}

/**
 * Drain the SDK's independent message buffer while `onDelta` keeps feeding
 * raw updates. `wait()` may settle before the buffer closes. Record its
 * result only after both settle, including on cancellation or failure.
 * An iterator failure is evidence of a lost view, not the run's outcome.
 */
export async function observeRun(run: CursorRun, record: (frame: CursorFrame) => void): Promise<CursorFrame> {
  const stream = (async (): Promise<void> => {
    try {
      for await (const message of run.stream()) { record(cursorStreamFrame(message)); }
    } catch (error) {
      record({ type: "cursor/stream_failed", native: { message: error instanceof Error ? error.message : String(error) }, events: [], agentPath: [] });
    }
  })();
  const terminal = (async (): Promise<CursorFrame> => {
    try { return cursorRunResultFrame(await run.wait()); }
    catch (error) { return cursorRunFailedFrame(error instanceof Error ? error.message : String(error)); }
  })();
  const [, frame] = await Promise.all([stream, terminal]);
  return frame;
}

/**
 * A run the SDK returned after its launch was given up: it did start, so it
 * is stopped, and its end still enters the stream.
 */
export function stopOrphan(run: CursorRun, record: (frame: CursorFrame) => void): void {
  void (async (): Promise<void> => {
    const terminal = observeRun(run, record);
    try {
      await run.cancel();
    } catch {
      // It may have ended on its own.
    }
    record(await terminal);
  })();
}

export async function steerRun(current: ActiveRun, input: string): Promise<ResponseBody> {
  const steer = current.run.steer?.bind(current.run);
  if (steer === undefined) {
    return { kind: "rejected", code: "runtime_refused", reason: "not_steerable: this cursor run takes no mid-run input" };
  }
  // `run.steer` settles once the agent took the text ("complete_delivered")
  // or handed it back ("revert_to_followup"); a run that ends first must
  // not leave the request unanswered, and a steer it outran must not reject
  // unobserved.
  const delivery = (async (): Promise<SteerAckOutcome | Error> => {
    try {
      return await steer(input);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();
  const runEnded = (async (): Promise<null> => {
    await current.ended;
    return null;
  })();
  const ack = await Promise.race([delivery, runEnded]);
  if (ack instanceof Error) {
    throw ack;
  }
  if (ack === "complete_delivered") {
    return { kind: "accepted", native: { ack } };
  }
  return {
    kind: "rejected",
    code: "runtime_refused",
    reason: ack === null ? "not_steerable: the run ended before cursor took the input" : `not_steerable: cursor handed the input back (${ack})`,
    ...(ack === null ? {} : { native: { ack } }),
  };
}
