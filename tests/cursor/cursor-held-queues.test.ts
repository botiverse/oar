/* oxlint-disable max-statements -- Each scenario checks acceptance, the native decision and final ownership. */
import { setImmediate as settle } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { conversationOf } from "../../packages/oar/src/observe/conversation.js";
import { awaitIdle, awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { openFakeCursor } from "../fixtures/fake-cursor-sdk.js";
import { inputIdOf, withdraw } from "../fixtures/withdraw.js";

afterEach(() => { vi.useRealTimers(); });

test.each([false, true])("Cursor SDK refusal releases only that queued input, next held: %s", async more => {
  const { session, agent } = await openFakeCursor();
  try {
    await session.prompt("A");
    const refused = await session.queue("B");
    if (more) { await session.queue("C"); }
    agent.refuse = new Error("fixture SDK refusal");
    const observed: { status: string; prompt: ReturnType<typeof session.prompt> }[] = [];
    session.rawEvents(record => {
      if (record.kind !== "frame" || record.body.type !== "cursor/send_rejected") { return; }
      observed.push({ status: session.status().value.kind, prompt: session.prompt("D") });
    });
    agent.latest().end("finished"); await settle();
    expect(observed[0]?.status).toBe(more ? "running" : "idle");
    expect(await observed[0]?.prompt).toMatchObject(more ? { kind: "rejected", code: "busy" } : { kind: "accepted" });
    expect(agent.runs.map(run => run.message)).toEqual(["A", more ? "C" : "D"]);
    const input = [...conversationOf(session.records()).inputs.values()].find(value => value.inputId === inputIdOf(refused));
    expect(input).toMatchObject({ state: "dropped", reason: "runtime_refused" });
    expect(await awaitTurnEnd(session, refused.seq, inputIdOf(refused))).toMatchObject({ kind: "failed" });
    agent.latest().end("finished"); await settle();
    expect(session.status().value.kind).toBe("idle");
  } finally { await session.dispose(); }
});

test.each(["finish", "abort", "dispose"] as const)("Cursor slow queued send keeps unknown ownership past 60 seconds: %s", async action => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { session, agent } = await openFakeCursor();
  const release = Promise.withResolvers<void>(); agent.gate = release.promise;
  try {
    const queued = await session.queue("slow");
    expect(queued.response.body).toEqual({ kind: "accepted", queued: "adapter" });
    await session.queue("next");
    let idle = false;
    const idleWait = (async () => { const value = await awaitIdle(session); idle = true; return value; })();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(session.status().value.kind).toBe("running");
    expect(idle).toBe(false);
    expect(await session.prompt("overtake")).toMatchObject({ kind: "rejected", code: "busy" });
    expect(await withdraw(session, inputIdOf(queued))).toBe("not_queued");
    expect(agent.runs).toHaveLength(0);
    expect(session.records().filter(record => record.kind === "frame" && record.body.type === "cursor/send_rejected")).toEqual([]);
    const dispatches = session.records().filter(record => record.kind === "request" && record.body.kind === "prompt" && record.body.carries !== undefined);
    expect(dispatches).toHaveLength(1);
    expect(session.records().filter(record => record.kind === "response" && record.requestId === (dispatches[0]?.kind === "request" ? dispatches[0].id : ""))).toEqual([]);
    if (action === "dispose") {
      await session.dispose();
    } else {
      const abort = action === "abort" ? session.abort() : undefined;
      release.resolve(); await settle(); await abort;
      if (action === "finish") { expect(agent.latest().cancelled).toBe(false); agent.latest().end("finished"); await settle(); }
      else { expect(agent.runs[0]?.cancelled).toBe(true); }
      expect(agent.runs.map(run => run.message)).toEqual(["slow", "next"]);
      expect(idle).toBe(false);
      agent.latest().end("finished"); await settle();
    }
    await idleWait;
    expect(session.status().value.kind).toBe("idle");
  } finally { await session.dispose(); release.resolve(); await settle(); }
});

test("Cursor immediate run ends do not leave a queue reservation behind", async () => {
  const { session, agent } = await openFakeCursor(); agent.endAtOnce = "finished";
  try {
    await session.queue("one"); await session.queue("two"); await settle();
    expect(agent.runs.map(run => run.message)).toEqual(["one", "two"]);
    expect(session.status().value.kind).toBe("idle");
    expect(await session.prompt("three")).toMatchObject({ kind: "accepted" });
  } finally { await session.dispose(); }
});
