import { randomUUID } from "node:crypto";
import type {
  ControlOutcome,
  ControlResult,
  InputOptions,
  AdapterSession,
  Session,
  SteerOrQueueResult,
} from "../contracts/session.js";
import { statusOf } from "../observe/agent-status.js";
import { coalesceText, eventsReader } from "../observe/events.js";
import { contextUsageOf, effortOf, modelOf, usageOf } from "../observe/usage.js";
import { deliverInto } from "./deliver.js";

const identify = (options: InputOptions = {}): InputOptions => {
  const inputId = options.inputId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(inputId)) {
    throw new Error("inputId must be a UUID");
  }
  return { ...options, inputId };
};

/**
 * Read a control's answer off its two records. A toRuntime control is only
 * ever answered `accepted` or `rejected`; the other two bodies answer other
 * things (`answered`: a toApp request; `exited`: a dispose), so they are
 * mapped totally rather than thrown on, should an adapter ever route one here.
 */
export function controlOutcomeOf(result: ControlResult): ControlOutcome {
  const { request, response } = result;
  const at = { request, response, seq: request.seq, requestId: request.id };
  if (response.body.kind === "rejected") {
    return { kind: "rejected", code: response.body.code, reason: response.body.reason, ...at };
  }
  if (response.body.kind === "exited") {
    return { kind: "rejected", code: "runtime_exited", reason: "runtime exited", ...at };
  }
  return { kind: "accepted", ...at };
}

/**
 * Derive the API face of a Session from what the adapter built: the read
 * control answers (`ControlOutcome` over the adapter's records), the flat
 * `events()` reading of the stream, the stream folds (model / effort / usage /
 * contextUsage / status are projections over `records()`, never adapter-held
 * snapshots) and the steer-or-queue policy. Method-style so consumers
 * discover the surfaces in autocomplete; one implementation instead of one
 * per adapter.
 */

export function sealSession(adapterSession: AdapterSession): Session {
  const prompt = async (input: string, options?: InputOptions): Promise<ControlOutcome> =>
    controlOutcomeOf(await adapterSession.prompt(input, { ...options, ...identify(options) }));
  // A session that cannot steer has no `steer`: its absence is the capability.
  // Where the adapter has one, the sealed `steer` below replaces it in the spread.
  const adapterFace: Omit<AdapterSession, "steer"> = adapterSession;
  const adapterSteer = adapterSession.steer?.bind(adapterSession);
  const steer = adapterSteer === undefined
    ? undefined
    : async (input: string, options?: InputOptions): Promise<ControlOutcome> =>
      controlOutcomeOf(await adapterSteer(input, identify(options)));
  const queue = async (input: string, options?: InputOptions): Promise<ControlOutcome> =>
    controlOutcomeOf(await adapterSession.queue(input, identify(options)));
  const abort = async (): Promise<ControlOutcome> => controlOutcomeOf(await adapterSession.abort());
  const steerOrQueue = async (input: string, options?: InputOptions): Promise<SteerOrQueueResult> => {
    const identified = identify(options);
    if (steer !== undefined) {
      const steered = await steer(input, identified);
      if (steered.kind === "accepted") {
        return { landed: "steered", result: steered };
      }
    }
    const queued = await queue(input, identified);
    return queued.kind === "accepted"
      ? { landed: "queued", result: queued }
      : { landed: "rejected", code: queued.code, reason: queued.reason, result: queued };
  };
  const sealed: Session = {
    ...adapterFace,
    prompt,
    ...(steer === undefined ? {} : { steer }),
    queue,
    abort,
    events: (observer, options = {}) => {
      const coalesce = options.coalesceText ?? false;
      const target = coalesce === false
        ? observer
        : coalesceText(observer, coalesce === true ? {} : { maxHoldMs: coalesce.maxHoldMs });
      return adapterSession.rawEvents(eventsReader(target), options.cursor);
    },
    model: () => modelOf(adapterSession.records(), adapterSession.id),
    effort: () => effortOf(adapterSession.records(), adapterSession.id),
    usage: () => usageOf(adapterSession.records(), adapterSession.id),
    contextUsage: () => contextUsageOf(adapterSession.records(), adapterSession.id),
    status: () => statusOf(adapterSession.records(), adapterSession.id),
    steerOrQueue,
    deliver: async (input, options = {}) => {
      const result = await deliverInto(sealed, input, { ...options, inputId: identify(options).inputId ?? "" });
      return result;
    },
  };
  return sealed;
}
