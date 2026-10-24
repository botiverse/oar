import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, onTestFailed, test } from "vitest";
import { serveMcpTools } from "../../packages/oar/src/index.js";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { qoderFixture } from "./support/qoder-fixture.js";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  const limit = Promise.withResolvers<never>();
  const timer = setTimeout(() => { limit.reject(new Error("Qoder steer observation exceeded 20 seconds")); }, 20_000);
  try { return await Promise.race([promise, limit.promise]); } finally { clearTimeout(timer); }
}

test.skipIf(process.env.OAR_TEST !== "qoder-native").each(["tool", "streaming"] as const)("next-priority steer preserves input identity at %s", async (phase) => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const server = await serveMcpTools({ name: "gate", tools: [{ name: "hold", inputSchema: { type: "object", properties: {} },
    handler: async (): Promise<string> => { entered.resolve(); await release.promise; return "gate released"; } }] });
  try {
    const fixture = await qoderFixture([phase === "tool" ? { tool: { name: "mcp__gate__hold", args: {} } } : { chunks: Array.from({ length: 10 }, () => "stream ") }, { text: "steer completed" }], 200);
    const session = await qoderSession({ kind: "available", via: "executable", command: process.env.OAR_QODER_BIN ?? "qodercli" }, { ...fixture.options, model: "efficient", mcpServers: [server.server] });
    onTestFailed(async () => {
      const directory = path.join(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "qoder-steer");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${phase}.json`), JSON.stringify(session.records(), null, 2));
    });
    try {
      assert.ok(typeof session.steer === "function", "Qoder must expose its verified next-priority path");
      const firstId = randomUUID(), steerId = randomUUID();
      const streamed = Promise.withResolvers<void>();
      const echoed = Promise.withResolvers<number>();
      const unsubscribe = session.rawEvents((record) => {
        if (record.kind === "frame" && record.body.events.some((event) => event.kind === "text_delta")) { streamed.resolve(); }
        if (record.kind === "frame" && record.body.events.some((event) => event.kind === "user_message" && event.inputId === steerId)) { echoed.resolve(record.seq); }
      });
      const initial = await session.prompt("initial input", { inputId: firstId });
      expect(initial.response.body.kind).toBe("accepted");
      await bounded(phase === "tool" ? entered.promise : streamed.promise);
      const steered = await session.steer("injected input", { inputId: steerId });
      expect(steered.response.body.kind).toBe("accepted");
      release.resolve();
      // A steer can join this turn or the next one. Its echo establishes entry;
      // the first end after the control request alone could belong to the old turn.
      const echoSeq = await bounded(echoed.promise);
      const [initialOutcome, steerOutcome] = await bounded(Promise.all([
        awaitTurnEnd(session, initial.request.seq, firstId), awaitTurnEnd(session, echoSeq, steerId),
      ]));
      expect(initialOutcome).toEqual({ kind: "completed" });
      expect(steerOutcome).toEqual({ kind: "completed" });
      const events = session.records().flatMap((record) => record.kind === "frame" ? record.body.events : []);
      expect(events.filter((event) => event.kind === "turn_ended")).toHaveLength(phase === "tool" ? 1 : 2);
      expect(events).toContainEqual(expect.objectContaining({ kind: "user_message", inputId: steerId, input: "injected input" }));
      expect(events.filter((event) => event.kind === "input_dropped")).toEqual([]);
      unsubscribe();
    } finally { release.resolve(); await session.dispose(); }
  } finally { release.resolve(); await server.close(); }
}, 90_000);
