import type { Session, StartSession } from "../packages/oar/src/contracts/session.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";

/**
 * The mock session runtime: conformance fixture and (later) load source. Its
 * size is deliberate — the session contract is supposed to be implementable in
 * about one screenful, and this file is that acceptance test.
 */
export const startMockSession: StartSession = async (): Promise<Session> => {
  await Promise.resolve();
  const kernel = createSessionKernel();
  const steered: string[] = [];
  return {
    id: kernel.sessionId,
    prompt(input) {
      const turn = kernel.begin();
      if (turn === null) {
        return { kind: "busy" };
      }
      const timer = setTimeout(() => {
        turn.emit({ kind: "text_delta", text: `echo:${input}` });
        for (const extra of steered.splice(0)) {
          turn.emit({ kind: "text_delta", text: `steer:${extra}` });
        }
        turn.settle({ kind: "completed" });
      }, 10);
      return {
        kind: "turn",
        turn: {
          id: turn.id,
          outcome: turn.outcome,
          abort: async () => {
            await Promise.resolve();
            clearTimeout(timer);
            turn.settle({ kind: "aborted" });
          },
          steer: async (extra) => {
            await Promise.resolve();
            steered.push(extra);
            return { kind: "accepted" };
          },
        },
      };
    },
    subscribe: (observer) => kernel.subscribe(observer),
    dispose: async () => {
      await Promise.resolve();
      kernel.active()?.settle({ kind: "aborted" });
    },
  };
};
