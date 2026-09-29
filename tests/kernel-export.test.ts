import { describe, expect, it } from "vitest";
import { defineRuntime, promptAndWait } from "../packages/oar/src/index.js";
import { createSessionKernel, sealSession } from "../packages/oar/src/kernel.js";

// The kernel subpath is enough to build a working custom runtime: the stream
// contract (seq, control records, status fold) comes from the kernel, the
// adapter only decides and speaks.
describe("@botiverse/oar/kernel", () => {
  it("builds a custom runtime whose session satisfies the prompt contract", async () => {
    const runtime = defineRuntime({
      id: "echo",
      session: async (_installation, options) => {
        await Promise.resolve();
        const kernel = createSessionKernel(options.resume);
        return sealSession({
          id: kernel.sessionId,
          capabilities: { steer: false, queue: null, attribution: "none", approvals: { kind: "unsupported", code: "no_gate", reason: "echo asks nothing" } },
          prompt: async (input, inputOptions) =>
            kernel.control({ kind: "prompt", input, ...inputOptions }, () => {
              setTimeout(() => {
                kernel.frame({ type: "echo", native: { input }, events: [
                  { kind: "text_delta", text: `echo:${input}` },
                  { kind: "turn_ended", outcome: { kind: "completed" } },
                ] });
              }, 1);
              return { kind: "accepted" };
            }),
          steer: async (input) => kernel.control({ kind: "steer", input }, () => ({ kind: "rejected", code: "unsupported", reason: "no steer" })),
          queue: async (input) => kernel.control({ kind: "queue", input }, () => ({ kind: "rejected", code: "unsupported", reason: "no queue" })),
          abort: async () => kernel.control({ kind: "abort" }, () => ({ kind: "rejected", code: "no_active_turn", reason: "idle" })),
          answer: async (requestId, decision) => kernel.answer(requestId, decision, () => ({ kind: "rejected", code: "unsupported", reason: "echo asks nothing" })),
          rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
          records: () => kernel.records(),
          graph: () => kernel.graph(),
          dispose: async () => {
            const request = kernel.request("toRuntime", { kind: "dispose" });
            kernel.respond(request.id, { kind: "exited", code: 0 });
            await Promise.resolve();
          },
        });
      },
    });
    const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "." });
    const run = await promptAndWait(session, "hi");
    expect(run.kind).toBe("ended");
    expect(session.status().value.kind).toBe("idle");
    expect(session.records().map((record) => record.kind)).toEqual(["request", "response", "frame"]);
    await session.dispose();
  });
});
