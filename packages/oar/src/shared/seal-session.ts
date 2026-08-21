import type {
  AdapterSession,
  Session,
  SteerOrQueueResult,
  Turn,
} from "../contracts/session.js";

/**
 * Derive the API face of a Session from what the adapter built. Method-style
 * so consumers discover the policy in autocomplete instead of hunting for a
 * free function; one implementation instead of one per adapter.
 */
export function sealSession(adapterSession: AdapterSession): Session {
  const steerOrQueue = async (turn: Turn, input: string): Promise<SteerOrQueueResult> => {
    let reason = "runtime cannot steer";
    if (turn.steer !== undefined) {
      const steered = await turn.steer(input);
      if (steered.kind === "accepted") {
        return { landed: "steered" };
      }
      ({ reason } = steered);
    }
    if (adapterSession.queue !== undefined) {
      await adapterSession.queue.add(input);
      return { landed: "queued" };
    }
    return { landed: "rejected", reason };
  };
  return { ...adapterSession, steerOrQueue };
}
