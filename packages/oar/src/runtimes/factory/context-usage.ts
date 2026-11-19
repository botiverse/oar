import type { RuntimeEventBody } from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import type { DroidClient, DroidOutcome } from "./client.js";
import { contextOf } from "./open.js";

/** Default bound for post-turn `droid.get_context_stats` before emitting `turn_ended`. */
export const FACTORY_CONTEXT_TIMEOUT_MS = 1000;

export interface FactoryContextReadback {
  /** Fire-and-forget read (used at open); a stale reply never overwrites a newer readback. */
  readBackground(): void;
  /** Bounded read awaited before emitting a completed turn's `turn_ended`; timeout keeps the previous value. */
  readBounded(): Promise<void>;
  /** Cancel any active bounded wait immediately (on abort, dispose, or process exit). */
  end(): void;
}

export function factoryContextReadback(
  client: Pick<DroidClient, "request">,
  recordReply: (type: string, events: (result: JsonRecord) => readonly RuntimeEventBody[]) => (outcome: DroidOutcome) => void,
  unreachable: () => unknown,
  timeoutMs: number = FACTORY_CONTEXT_TIMEOUT_MS,
): FactoryContextReadback {
  let generation = 0;
  let cancelActive: (() => void) | null = null;

  return {
    readBackground(): void {
      if (unreachable() !== null) { return; }
      const mine = ++generation;
      void (async (): Promise<void> => {
        try {
          await client.request("droid.get_context_stats", {}, recordReply("droid.get_context_stats", (result) => {
            if (mine !== generation) { return []; }
            const context = contextOf(result);
            return context === null ? [] : [{ kind: "usage", usage: { context } }];
          }));
        } catch { /* Its reply, an error included, is already a frame; an exit is the exited response. */ }
      })();
    },
    async readBounded(): Promise<void> {
      if (unreachable() !== null) { return; }
      const mine = ++generation;
      let settled = false;
      let expired = false;
      const { promise, resolve } = Promise.withResolvers<void>();
      const done = (): void => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        if (cancelActive === cancel) { cancelActive = null; }
        resolve();
      };
      const cancel = (): void => { expired = true; done(); };
      const timer = setTimeout(cancel, timeoutMs);
      cancelActive = cancel;
      const onReply = recordReply("droid.get_context_stats", (result) => {
        if (expired || mine !== generation) { return []; }
        const context = contextOf(result);
        return context === null ? [] : [{ kind: "usage", usage: { context } }];
      });
      void (async (): Promise<void> => {
        try {
          await client.request("droid.get_context_stats", {}, (outcome) => {
            onReply(outcome);
            done();
          });
        } catch { done(); }
      })();
      await promise;
    },
    end(): void {
      const cancel = cancelActive;
      cancelActive = null;
      cancel?.();
    },
  };
}
