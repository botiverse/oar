import { expect, test, vi } from "vitest";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { startDurableFixture } from "../harness/pi-durable.js";

const nativeTest = test.skipIf(process.env.OAR_TEST !== "pi-durable-aimock");

nativeTest("abort ends nested running slots and preserves the unstarted sequential call's native result", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pending = vi.fn(async () => { await Promise.resolve(); return { output: [{ type: "text" as const, text: "must not run" }] }; });
  const leaf = defineTool({ name: "leaf", description: "held leaf", parameters: { type: "object", properties: {} }, replay: "safe",
    execute: async (_args, _api, context) => { entered.resolve(); await awaitWithContext(release.promise, context); return { output: [] }; },
  });
  const outer = defineTool({ name: "outer", description: "outer", parameters: { type: "object", properties: {} }, replay: "safe", executionMode: "sequential",
    execute: async (_args, api, context) => { await api.executeTool("leaf", {}, context, { key: "nested" }); return { output: [] }; },
  });
  const never = defineTool({ name: "never", description: "pending", parameters: { type: "object", properties: {} }, execute: pending });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "removed-tools", tools: [leaf, outer, never] }));
  const fixture = await startDurableFixture(mock => {
    mock.onMessage(/.*/u, { toolCalls: [{ id: "outer", name: "outer", arguments: "{}" }, { id: "pending", name: "never", arguments: "{}" }] });
  }, undefined, registry);
  const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model" });
  try {
    const first = await session.prompt("run sequential tools");
    await entered.promise;
    await vi.waitFor(() => { expect(session.records().flatMap(record => record.kind === "frame" ? record.body.events : [])).toContainEqual({ kind: "tool_call_started", callId: "outer/nested", tool: "leaf", input: "{}" }); });
    const abort = await session.abort();
    expect(abort.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "aborted" });
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(session.status().value.kind).toBe("idle");
    await session.dispose();
    const events = session.records().flatMap(record => record.kind === "frame" ? record.body.events : []);
    expect(events.filter(event => event.kind === "tool_call_ended" && event.callId === "outer/nested")).toEqual([{ kind: "tool_call_ended", callId: "outer/nested", result: "failed" }]);
    expect(events.filter(event => event.kind === "tool_call_ended" && event.callId === "pending")).toEqual([{ kind: "tool_call_ended", callId: "pending", result: "failed", content: [{ type: "text", text: "<harness>\n[error] Tool never was aborted\n</harness>" }] }]);
    expect(events.some(event => event.kind === "tool_call_started" && event.callId === "pending")).toBe(false);
    expect(pending).not.toHaveBeenCalled();
  } finally { release.resolve(); await session.dispose(); await fixture.close(); }
});

nativeTest("a parent finishing with an unawaited nested call preserves its native failure summary", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const leaf = defineTool({ name: "leaf", description: "held leaf", parameters: { type: "object", properties: {} }, replay: "safe",
    execute: async (_args, _api, context) => { entered.resolve(); await awaitWithContext(release.promise, context); return { output: [] }; },
  });
  const outer = defineTool({ name: "outer", description: "returns before child", parameters: { type: "object", properties: {} }, replay: "safe",
    execute: async (_args, api, context) => {
      // Deliberately finish the parent first; native ownership closes the child.
      // oxlint-disable-next-line promise/prefer-await-to-then -- This control deliberately leaves the nested call unawaited.
      void api.executeTool("leaf", {}, context, { key: "nested" }).catch(() => undefined);
      await entered.promise;
      return { output: [{ type: "text", text: "parent finished" }] };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "orphaned-nested-tool", tools: [leaf, outer] }));
  const fixture = await startDurableFixture(mock => {
    mock.on({ hasToolResult: false }, { toolCalls: [{ id: "outer", name: "outer", arguments: "{}" }] });
    mock.on({ hasToolResult: true }, { content: "done" });
  }, undefined, registry);
  const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model" });
  try {
    const first = await session.prompt("use outer");
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect(session.status().value.kind).toBe("idle");
    await session.dispose();
    const events = session.records().flatMap(record => record.kind === "frame" ? record.body.events : []);
    expect(events.filter(event => event.kind === "tool_call_started" && event.callId === "outer/nested")).toEqual([{ kind: "tool_call_started", callId: "outer/nested", tool: "leaf", input: "{}" }]);
    expect(events.filter(event => event.kind === "tool_call_ended" && event.callId === "outer/nested")).toEqual([{ kind: "tool_call_ended", callId: "outer/nested", result: "failed" }]);
  } finally { release.resolve(); await session.dispose(); await fixture.close(); }
});
