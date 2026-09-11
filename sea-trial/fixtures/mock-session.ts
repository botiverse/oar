import type { Session, StartSession } from "../../packages/oar/src/contracts/session.js";
import { sealSession } from "../../packages/oar/src/shared/seal-session.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

/**
 * The mock session runtime: behavior-test fixture and (later) load source. Its
 * size is deliberate: the session contract is supposed to be implementable in
 * about one screenful, and this file is that acceptance test. The "runtime"
 * here is a timer that echoes; its frames are the `native` bodies.
 */
export const startMockSession: StartSession = async (_installation, options): Promise<Session> => {
  await Promise.resolve();
  const kernel = createSessionKernel(options.resume);
  const steered: string[] = [];
  const queued: string[] = [];
  let active: { timer: NodeJS.Timeout | null; aborted: boolean } | null = null;
  let disposed = false;
  const say = (text: string): void => {
    kernel.event({ type: "mock/text", native: { text }, views: [{ kind: "text_delta", text }] });
  };
  const end = (outcome: "completed" | "aborted"): void => {
    active = null;
    kernel.event({ type: "mock/end", native: { outcome, used: 1 }, views: [
      { kind: "turn_ended", outcome: { kind: outcome } },
      { kind: "usage", usage: { context: { tokens: 1, contextWindow: 100, percent: 1 }, tokens: { input: 1, output: 1 } } },
    ] });
    const next = queued.shift();
    if (next !== undefined) {
      run(next);
    }
  };
  function run(input: string): void {
    // "hang" never settles on its own; the stall-observation fixture.
    const timer = input === "hang" ? null : setTimeout(() => {
      say(`echo:${input}`);
      for (const extra of steered.splice(0)) {
        say(`steer:${extra}`);
      }
      end("completed");
    }, 10);
    active = { timer, aborted: false };
  }
  kernel.event({ type: "mock/model", native: { model: "mock-1" }, views: [{ kind: "model", model: "mock-1" }] });
  return sealSession({
    id: kernel.sessionId,
    capabilities: { steer: true, queue: { durable: false }, attribution: "none" },
    prompt: async (input) => {
      const result = await kernel.control({ kind: "prompt", input }, () => {
      if (disposed) {
        return { kind: "rejected", reason: "session disposed" };
      }
      if (active !== null) {
        return { kind: "rejected", reason: "busy" };
      }
      run(input);
      return { kind: "accepted" };
      });
      return result;
    },
    steer: async (input) => {
      const result = await kernel.control({ kind: "steer", input }, () => {
      if (active === null) {
        return { kind: "rejected", reason: "not_steerable: no active turn" };
      }
      steered.push(input);
      return { kind: "accepted" };
      });
      return result;
    },
    queue: async (input) => {
      const result = await kernel.control({ kind: "queue", input }, () => {
      if (active === null) {
        run(input);
      } else {
        queued.push(input);
      }
      return { kind: "accepted" };
      });
      return result;
    },
    abort: async () => {
      const result = await kernel.control({ kind: "abort" }, () => {
      if (active === null) {
        return { kind: "rejected", reason: "no active turn" };
      }
      if (active.timer !== null) {
        clearTimeout(active.timer);
      }
      end("aborted");
      return { kind: "accepted" };
      });
      return result;
    },
    subscribe: (observer, cursor) => kernel.subscribe(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const request = kernel.request("toRuntime", { kind: "dispose" });
      if (active !== null) {
        if (active.timer !== null) {
          clearTimeout(active.timer);
        }
        end("aborted");
      }
      kernel.respond(request.id, { kind: "exited", code: 0 });
      await Promise.resolve();
    },
  });
};
