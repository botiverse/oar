import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startDurableFixture } from "../harness/pi-durable.js";

test.skipIf(process.env.OAR_TEST !== "pi-durable-aimock")("Durable 1.5 retains nested CodingTools exits only for the caller, not in conversation observations", async () => {
  const directory = await mkdtemp(`${tmpdir()}/oar-durable-exit-`);
  await writeFile(`${directory}/probe.txt`, "control");
  const commands = [
    { id: "zero", command: "exit 0", code: 0 },
    { id: "seven", command: "exit 7", code: 7 },
    ...(process.platform === "win32" ? [] : [{ id: "signal", command: "kill -TERM $$", code: 143 }]),
  ];
  const registry = createRegistry();
  const nestedResults = new Map<string, unknown>();
  registry.install(CodingTools);
  const outer = defineTool({
    name: "outer", description: "Call CodingTools", parameters: { type: "object", properties: {} }, replay: "safe",
    execute: async (_args, api, context) => {
      await Promise.all(commands.map(async ({ id, command }) => { nestedResults.set(id, await api.executeTool("bash", { command }, context, { key: id })); }));
      await api.executeTool("read", { path: "probe.txt" }, context, { key: "read" });
      return { output: [{ type: "text", text: "done" }] };
    },
  });
  registry.install(defineExtension({ name: "exit-probe", tools: [outer] }));
  const fixture = await startDurableFixture((mock) => {
    mock.on({ hasToolResult: false }, { toolCalls: [
      ...commands.map(({ id, command }) => ({ id, name: "bash", arguments: JSON.stringify({ command }) })),
      { id: "read", name: "read", arguments: JSON.stringify({ path: "probe.txt" }) },
      { id: "outer", name: "outer", arguments: "{}" },
    ] });
    mock.on({ hasToolResult: true }, { content: "done" });
  }, undefined, registry, () => new NodeExecutionEnv({ cwd: directory }));
  let session: Session | undefined = undefined;
  try {
    session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: directory, model: "aimock/aimock-model" });
    expect(await promptAndWait(session, "run exit-code probes")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const records = session.records();
    const frames = records.flatMap((record) => record.kind === "frame" ? [record.body] : []);
    const ended = frames.flatMap((body) => body.events).filter((event) => event.kind === "tool_call_ended");
    for (const { id, code } of commands) {
      const result = asRecord(nestedResults.get(id));
      expect(asRecord(result?.structuredOutput)?.exitCode).toBe(code);
      expect(ended).toContainEqual({ kind: "tool_call_ended", callId: `outer/${id}`, result: code === 0 ? "ok" : "failed" });
      // The caller sees the structured result. The native live slot retains
      // only a summary, and model-issued entries contain no structured exit.
      expect(ended.find((event) => event.callId === `outer/${id}`)).not.toHaveProperty("exitCode");
      expect(ended.find((event) => event.callId === id)).not.toHaveProperty("exitCode");
    }
    expect(ended.find((event) => event.callId === "read")).not.toHaveProperty("exitCode");
    expect(ended.find((event) => event.callId === "outer/read")).not.toHaveProperty("exitCode");
    const json = JSON.stringify(records);
    expect(JSON.parse(json)).toEqual(records);
  } finally {
    await session?.dispose();
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}, 60_000);
