import type {
  AdapterSession,
  Session,
  SteerOrQueueResult,
} from "../contracts/session.js";
import { contextUsageOf, modelOf, usageOf } from "../observe/usage.js";

/**
 * Derive the API face of a Session from what the adapter built: the stream
 * folds (model / usage / contextUsage are projections over `records()`, never
 * adapter-held snapshots) and the steer-or-queue policy. Method-style so
 * consumers discover the surfaces in autocomplete; one implementation instead
 * of one per adapter.
 */
export function sealSession(adapterSession: AdapterSession): Session {
  const steerOrQueue = async (input: string): Promise<SteerOrQueueResult> => {
    const steered = await adapterSession.steer(input);
    if (steered.response.body.kind === "accepted") {
      return { landed: "steered", result: steered };
    }
    const reason = steered.response.body.kind === "rejected" ? steered.response.body.reason : "runtime cannot steer";
    if (adapterSession.capabilities.queue === null) {
      return { landed: "rejected", reason, result: steered };
    }
    const queued = await adapterSession.queue(input);
    return queued.response.body.kind === "accepted"
      ? { landed: "queued", result: queued }
      : { landed: "rejected", reason: queued.response.body.kind === "rejected" ? queued.response.body.reason : reason, result: queued };
  };
  return {
    ...adapterSession,
    model: () => modelOf(adapterSession.records()),
    usage: () => usageOf(adapterSession.records()),
    contextUsage: () => contextUsageOf(adapterSession.records()),
    steerOrQueue,
  };
}
