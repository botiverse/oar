import type { ResponseBody } from "../../contracts/session.js";
import type { CursorRun, SteerAckOutcome } from "./sdk.js";

export interface ActiveRun {
  readonly run: CursorRun;
  /** Settles once the run's end is in the stream. */
  readonly ended: Promise<void>;
}

export async function steerRun(current: ActiveRun, input: string): Promise<ResponseBody> {
  const steer = current.run.steer?.bind(current.run);
  if (steer === undefined) {
    return { kind: "rejected", code: "unsupported", reason: "not_steerable: this cursor run takes no mid-run input" };
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

/** A promise's value or its rejection, as data. */
export async function settled<T>(work: Promise<T>): Promise<{ readonly value: T } | { readonly error: unknown }> {
  try {
    return { value: await work };
  } catch (error) {
    return { error };
  }
}
