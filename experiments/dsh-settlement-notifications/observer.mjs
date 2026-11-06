/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return -- Standalone observer of two installed DSH ABIs; injected native services have no types in this workspace. The typed runner validates the selected records. */
import { appendFileSync } from "node:fs";

export const name = "oar-settlement-observer";

// Diagnostic reads only. No native methods, messages or durable events are changed.
export function apply(ctx, config) {
  function agents() {
    return [...ctx.get("agents")?.list() ?? []].map(agent => ({
      id: agent.id, status: agent.status,
      nextTurn: agent.inbox.nextTurn, nextStep: agent.inbox.nextStep,
      hasPending: agent.inbox.hasPending,
    }));
  }
  function write(kind, data) {
    appendFileSync(config.output, `${JSON.stringify({ at: Date.now(), kind, data, agents: agents() })}\n`);
  }
  ctx.on("session/event", (session, event) => {
    write("session-event", { sessionId: session.id, event });
    if (["job/settled", "turn/end"].includes(event.type)) {
      const agent = ctx.get("agents")?.get(session.id);
      if (agent !== undefined) {
        // Keep the native event listener synchronous while observing the wait separately.
        void (async () => {
          await agent.whenIdle();
          write("whenIdle-resolved", { sessionId: session.id, afterType: event.type, afterSeq: event.seq });
        })();
      }
    }
    if (event.type === "job/settled") {
      queueMicrotask(() => { write("after-job-settled-dispatch", { sessionId: session.id, seq: event.seq, jobId: event.data.jobId }); });
    }
  });
  for (const channel of ["agent/inbox/inserted", "agent/inbox/claimed", "agent/inbox/discarded"]) {
    ctx.on(channel, ({ agent, message, turn }) => { write(channel, { sessionId: agent.id, message, turn }); });
  }
  ctx.on("agent/status", ({ agent, status }) => { write("agent/status", { sessionId: agent.id, status }); });
  for (const channel of ["subagent/start", "subagent/end"]) {
    ctx.on(channel, info => { write(channel, info); });
  }
  void (async () => {
    await ctx.get("loader").await();
    ctx.get("jobs").events.subscribe({ owners: "all" }, event => { write("jobs-live", event); });
    write("ready", {});
  })();
}
