import assert from "node:assert/strict";
import { getTextContent, type LLMock } from "@copilotkit/aimock";
import { expect, test, vi } from "vitest";
import type { ControlResult, Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { startPiAimock } from "../harness/aimock.js";
import { startDurableFixture } from "../harness/pi-durable.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { isPiBackend, piTestRuntime } from "./support/pi-runtime.js";

const durable = process.env.OAR_TEST === "pi-durable-aimock";

/** Native runs stop at the provider, not at a timer, so the observer sees a live next run. */
async function fixture() {
  const requests: string[] = [];
  const release = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const configure = (mock: LLMock): void => {
    mock.on({ predicate: () => true }, async request => {
      const input = getTextContent(request.messages.findLast(message => message.role === "user")?.content ?? null) ?? "";
      requests.push(input);
      const index = requests.length - 1;
      await release[index]?.promise;
      return { content: `reply to ${input}` };
    });
  };
  const env = durable ? await startDurableFixture(configure) : await startPiAimock(configure);
  const session = "runtime" in env
    ? await env.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model" })
    : await runtimeUnderTest(piTestRuntime).startSession();
  return { session, requests, release, entered: async (count: number) => {
    await vi.waitFor(() => { expect(requests, JSON.stringify(session.records().slice(-5))).toHaveLength(count); }, { timeout: 15_000 });
  }, close: async () => {
    for (const gate of release) { gate.resolve(); }
    await session.dispose();
    await ("close" in env ? env.close() : env.stop());
  } };
}

async function nextAtEnd(session: Session, action: () => Promise<ControlResult>) {
  const observed = Promise.withResolvers<{ status: string; result: Promise<ControlResult> }>();
  let ended = false;
  session.rawEvents(record => {
    if (ended || record.kind !== "frame" || !record.body.events.some(event => event.kind === "turn_ended")) { return; }
    ended = true;
    observed.resolve({ status: session.status().value.kind, result: action() });
  });
  return observed.promise;
}

// oxlint-disable-next-line max-statements -- Native A ends, its observer starts B, and B stays reserved until its own completion.
test.skipIf(!isPiBackend && !durable)("a native Pi terminal observer can prompt the next run without old cleanup releasing it", async () => {
  const native = await fixture(); const { session } = native;
  try {
    const observed = nextAtEnd(session, async () => session.prompt("B"));
    expect(await session.prompt("A")).toMatchObject({ kind: "accepted" });
    await native.entered(1); native.release[0]?.resolve();
    const next = await observed;
    expect(next.status).toBe("idle");
    const accepted = await next.result; assert.equal(accepted.response.body.kind, "accepted");
    await native.entered(2);
    expect(native.requests).toEqual(["A", "B"]);
    expect(session.status().value.kind).toBe("running");
    expect(await session.prompt("cannot overtake B")).toMatchObject({ kind: "rejected", code: "busy" });
    native.release[1]?.resolve();
    expect(await awaitTurnEnd(session, accepted.request.seq)).toEqual({ kind: "completed" });
    expect(session.status().value.kind).toBe("idle");
  } finally { await native.close(); }
}, 60_000);

// oxlint-disable-next-line max-statements -- Hold each native reply separately to prove FIFO through all three runs.
test.skipIf(!isPiBackend).each(["prompt", "queue"] as const)("native Pi held input keeps priority over observer %s", async control => {
  const native = await fixture(); const { session } = native;
  try {
    expect(await session.prompt("A")).toMatchObject({ kind: "accepted" });
    await native.entered(1);
    expect(await session.queue("B")).toMatchObject({ kind: "accepted" });
    const observed = nextAtEnd(session, async () => session[control]("C"));
    native.release[0]?.resolve();
    const next = await observed;
    expect(await next.result).toMatchObject(control === "queue" ? { kind: "accepted" } : { kind: "rejected", code: "busy" });
    await native.entered(2); assert.deepEqual(native.requests, ["A", "B"]);
    const afterB = session.records().at(-1)?.seq ?? -1;
    native.release[1]?.resolve();
    expect(await awaitTurnEnd(session, afterB)).toEqual({ kind: "completed" });
    if (control === "queue") {
      await native.entered(3); expect(native.requests).toEqual(["A", "B", "C"]);
      const afterC = session.records().at(-1)?.seq ?? -1;
      native.release[2]?.resolve();
      expect(await awaitTurnEnd(session, afterC)).toEqual({ kind: "completed" });
    }
    expect(native.requests).toEqual(control === "queue" ? ["A", "B", "C"] : ["A", "B"]);
  } finally { await native.close(); }
}, 60_000);
