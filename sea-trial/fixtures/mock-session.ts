import type { InputOptions, Session, StartSession } from "../../packages/oar/src/contracts/session.js";
import { sealSession } from "../../packages/oar/src/shared/seal-session.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

/** The mock's reasoning-effort menu (its `listModels` lists it for `mock-1`) and the level it runs when asked for none. */
export const MOCK_EFFORT_LEVELS: readonly string[] = ["low", "high"];
export const MOCK_DEFAULT_EFFORT = "high";
/** Under approvals "ask", an input naming this asks the host to approve a command before the turn goes on. */
export const MOCK_APPROVAL_PROBE = "oar-approval-probe";

/**
 * The mock session runtime: behavior-test fixture and (later) load source. Its
 * size is deliberate: the session contract is supposed to be implementable in
 * about one screenful, and this file is that acceptance test. The "runtime"
 * here is a timer that echoes; its frames are the `native` bodies.
 */
export const startMockSession: StartSession = async (_installation, options): Promise<Session> => {
  await Promise.resolve();
  const effort = options.effort ?? MOCK_DEFAULT_EFFORT;
  if (!MOCK_EFFORT_LEVELS.includes(effort)) {
    throw new Error(`mock runtime has no effort level ${effort} (levels: ${MOCK_EFFORT_LEVELS.join(", ")})`);
  }
  const kernel = createSessionKernel(options.resume);
  const steered: string[] = [];
  const queued: string[] = [];
  let active: { timer: NodeJS.Timeout | null; aborted: boolean } | null = null;
  let disposed = false;
  let asking: string | null = null; // the approval the running turn waits on
  let asked = 0;
  const say = (text: string): void => {
    kernel.frame({ type: "mock/text", native: { text }, events: [{ kind: "text_delta", text }] });
  };
  const end = (outcome: "completed" | "aborted"): void => {
    if (asking !== null) {
      // A turn that ends while it waits withdraws the request, as runtimes do.
      kernel.frame({ type: "mock/withdrawn", native: { requestId: asking }, events: [{ kind: "app_request_withdrawn", requestId: asking }] });
      asking = null;
    }
    active = null;
    kernel.frame({ type: "mock/end", native: { outcome, used: 1 }, events: [
      { kind: "turn_ended", outcome: { kind: outcome } },
      { kind: "usage", usage: { context: { tokens: 1, contextWindow: 100, percent: 1 }, tokens: { input: 1, output: 1 } } },
    ] });
    const next = queued.shift();
    if (next !== undefined) {
      run(next);
    }
  };
  function run(input: string): void {
    if (options.approvals === "ask" && input.includes(MOCK_APPROVAL_PROBE)) {
      asked += 1;
      asking = `mock-ask-${String(asked)}`;
      const command = "touch oar-approval-probe.txt";
      kernel.request("toApp", { kind: "native", type: "mock/approval", native: { command }, ask: {
        kind: "tool_approval", tool: "mock-shell", command, choices: ["allow", "allow_session", "deny"], denyMessage: true,
      } }, { id: asking });
      active = { timer: null, aborted: false };
      return;
    }
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
  kernel.frame({ type: "mock/model", native: { model: "mock-1", effort }, events: [{ kind: "model", model: "mock-1" }, { kind: "effort", effort }] });
  return sealSession({
    id: kernel.sessionId,
    capabilities: { steer: true, queue: { durable: false }, attribution: "none", approvals: { kind: "supported" } },
    prompt: async (input, inputOptions?: InputOptions) => {
      const body = { kind: "prompt" as const, input, ...inputOptions };
      const result = await kernel.control(body, () => {
      if (disposed) {
        return { kind: "rejected", code: "disposed", reason: "session disposed" };
      }
      if (active !== null) {
        return { kind: "rejected", code: "busy", reason: "busy" };
      }
      run(input);
      return { kind: "accepted" };
      });
      return result;
    },
    steer: async (input, inputOptions) => {
      const result = await kernel.control({ kind: "steer", input, ...inputOptions }, () => {
      if (active === null) {
        return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" };
      }
      steered.push(input);
      return { kind: "accepted" };
      });
      return result;
    },
    queue: async (input, inputOptions) => {
      const result = await kernel.control({ kind: "queue", input, ...inputOptions }, () => {
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
        return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
      }
      if (active.timer !== null) {
        clearTimeout(active.timer);
      }
      end("aborted");
      return { kind: "accepted" };
      });
      return result;
    },
    answer: async (requestId, decision) => {
      await Promise.resolve();
      return kernel.answer(requestId, decision, (_request, taken) => {
        if (asking !== requestId) {
          return { kind: "rejected", code: "unsupported", reason: "the mock asked nothing under this id" };
        }
        asking = null;
        const text = taken.kind === "deny" ? `denied:${taken.message ?? ""}` : "ran:touch oar-approval-probe.txt";
        const timer = setTimeout(() => {
          say(text);
          end("completed");
        }, 10);
        active = { timer, aborted: false };
        return { kind: "sent", native: taken };
      });
    },
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
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
