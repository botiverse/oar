import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { startDurableFixture } from "../harness/pi-durable.js";

test.skipIf(process.env.OAR_TEST !== "pi-durable-aimock").each([false, true])("nested tool results and active adoption preserve isError=%s", async (isError) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const leaf = defineTool({ name: "leaf", description: "nested call", parameters: Type.Object({}), replay: "safe",
    execute: async (_args, api) => {
      api.output("partial leaf"); entered.resolve(); await release.promise;
      return { output: [{ type: "text", text: "leaf result" }], isError };
    },
  });
  const outer = defineTool({ name: "outer", description: "outer call", parameters: Type.Object({}), replay: "safe",
    execute: async (_args, api, context) => {
      await api.executeTool("leaf", {}, context, { key: "nested" });
      return { output: [{ type: "text", text: "outer result" }] };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "nested-test", tools: [leaf, outer] }));
  const fixture = await startDurableFixture((mock) => {
    mock.on({ hasToolResult: false }, { toolCalls: [{ id: "call-outer", name: "outer", arguments: "{}" }] });
    mock.on({ hasToolResult: true }, { content: "answered" });
  }, undefined, registry);
  let session: Session | undefined = undefined;
  let adopted: Session | undefined = undefined;
  try {
    session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model" });
    const first = await session.prompt("use outer");
    await entered.promise;
    adopted = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", resume: session.id });
    const initial = adopted.records().flatMap((record) => record.kind === "frame" ? record.body.events : []);
    expect(initial).toContainEqual({ kind: "tool_call_started", tool: "leaf", callId: "call-outer/nested" });
    release.resolve();
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
    for (const controller of [session, adopted]) {
      await vi.waitFor(() => { expect(controller.status().value.kind).toBe("idle"); }, { timeout: 15_000 });
      const events = controller.records().flatMap((record) => record.kind === "frame" ? record.body.events : []);
      expect(events).toContainEqual({ kind: "tool_call_ended", callId: "call-outer/nested", result: isError ? "failed" : "ok" });
      expect(events).toContainEqual({ kind: "tool_call_ended", callId: "call-outer", result: "ok", content: [{ type: "text", text: "outer result" }] });
    }
  } finally { release.resolve(); await adopted?.dispose(); await session?.dispose(); await fixture.close(); }
});
