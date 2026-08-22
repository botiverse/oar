import type { Session, StartSession } from "../../packages/oar/src/contracts/session.js";
import { sealSession } from "../../packages/oar/src/shared/seal-session.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

/**
 * The mock session runtime: conformance fixture and (later) load source. Its
 * size is deliberate — the session contract is supposed to be implementable in
 * about one screenful, and this file is that acceptance test.
 */
export const startMockSession: StartSession = async (_installation, options): Promise<Session> => {
  await Promise.resolve();
  const kernel = createSessionKernel(options.resume);
  const steered: string[] = [];
  const queued: string[] = [];
  const drainQueue = (): void => {
    const next = queued.shift();
    const turn = next === undefined ? null : kernel.begin();
    if (next !== undefined && turn !== null) {
      turn.emit({ kind: "text_delta", text: `queued:${next}` });
      turn.settle({ kind: "completed" });
      drainQueue();
    }
  };
  return sealSession({
    id: kernel.sessionId,
    prompt(input) {
      const turn = kernel.begin();
      if (turn === null) {
        return { kind: "busy" };
      }
      // "hang" never settles on its own — the stall-observation fixture.
      const timer = input === "hang" ? null : setTimeout(() => {
        turn.emit({ kind: "text_delta", text: `echo:${input}` });
        for (const extra of steered.splice(0)) {
          turn.emit({ kind: "text_delta", text: `steer:${extra}` });
        }
        turn.settle({ kind: "completed" });
        drainQueue();
      }, 10);
      return {
        kind: "turn",
        turn: {
          id: turn.id,
          outcome: turn.outcome,
          abort: async () => {
            await Promise.resolve();
            if (timer !== null) {
              clearTimeout(timer);
            }
            turn.settle({ kind: "aborted" });
          },
          steer: async (extra) => {
            await Promise.resolve();
            if (turn.settled()) {
              return { kind: "not_steerable", reason: "turn already ended" };
            }
            steered.push(extra);
            return { kind: "accepted" };
          },
        },
      };
    },
    subscribe: (observer) => kernel.subscribe(observer),
    queue: {
      durable: false,
      add: async (input) => {
        await Promise.resolve();
        queued.push(input);
        if (kernel.active() === null) {
          drainQueue();
        }
      },
    },
    dispose: async () => {
      await Promise.resolve();
      kernel.active()?.settle({ kind: "aborted" });
    },
  });
};
