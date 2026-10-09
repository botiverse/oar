import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { startDurableFixture } from "../harness/pi-durable.js";

const nativeTest = test.skipIf(process.env.OAR_TEST !== "pi-durable-aimock");
nativeTest("steer joins the tool run, follow-up starts another run, and tools retain results", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const registry = createRegistry();
  const hold = defineTool({
    name: "hold", description: "hold until released", parameters: Type.Object({}), replay: "safe",
    execute: async (_args, api) => {
      api.output("before"); entered.resolve(); await release.promise; api.output(" after");
      return { content: [{ type: "text", text: "tool result" }] };
    },
  });
  registry.install(defineExtension({ name: "test-tools", tools: [hold] }));
  const fixture = await startDurableFixture((mock) => {
    mock.on({ hasToolResult: false }, { toolCalls: [{ id: "call-hold", name: "hold", arguments: "{}" }] });
    mock.on({ hasToolResult: true }, { content: "answered" });
  }, undefined, registry);
  try {
    const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model" });
    const first = await session.prompt("use hold");
    await entered.promise;
    const steered = await session.steer?.("steer marker");
    const queued = await session.queue("follow-up marker");
    expect([steered?.kind, queued.kind]).toEqual(["accepted", "accepted"]);
    release.resolve();
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    await vi.waitFor(() => { expect(session.status().value.kind).toBe("idle"); });
    const events = session.records().filter((record) => record.kind === "frame").flatMap((record) => record.body.events);
    expect(events.filter((event) => event.kind === "turn_ended")).toHaveLength(2);
    const echoes = events.filter((event) => event.kind === "user_message");
    expect(echoes.map((event) => event.input)).toEqual(["use hold", "steer marker", "follow-up marker"]);
    expect(events.filter((event) => event.kind === "tool_call_ended")).toMatchInlineSnapshot(`
      [
        {
          "callId": "call-hold",
          "content": [
            {
              "text": "tool result",
              "type": "text",
            },
          ],
          "kind": "tool_call_ended",
          "result": "ok",
        },
        {
          "callId": "call-hold",
          "content": [
            {
              "text": "tool result",
              "type": "text",
            },
          ],
          "kind": "tool_call_ended",
          "result": "ok",
        },
        {
          "callId": "call-hold",
          "content": [
            {
              "text": "tool result",
              "type": "text",
            },
          ],
          "kind": "tool_call_ended",
          "result": "ok",
        },
      ]
    `);
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    expect(JSON.stringify(fixture.mock.getRequests().at(-1))).toContain("steer marker");
    await session.dispose();
  } finally { release.resolve(); await fixture.close(); }
});

nativeTest("provider failures come from terminal native receipts", async () => {
  const fixture = await startDurableFixture((mock) => {
    mock.onMessage(/.*/u, { status: 400, error: { type: "invalid_request_error", message: "test provider refusal" } });
  });
  try {
    const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model" });
    const run = await promptAndWait(session, "fail");
    expect(run.kind).toBe("ended");
    if (run.kind === "ended") { expect(run.outcome.kind).toBe("failed"); }
    await session.dispose();
  } finally { await fixture.close(); }
});
