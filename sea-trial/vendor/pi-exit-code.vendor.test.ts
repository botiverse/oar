import { expect, test } from "vitest";
import { defineRuntime, piInstallation, piSession, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startPiAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";

test.skipIf(process.env.OAR_TEST !== "pi-aimock")("Pi's real CodingTools exit status survives the OAR projection and JSON storage", async () => {
  const commands = [
    { id: "exit_zero", command: "exit 0", code: 0 },
    { id: "exit_seven", command: "exit 7", code: 7 },
    // Pi's local process runner normalizes SIGTERM to 128 + 15.
    ...(process.platform === "win32" ? [] : [{ id: "exit_signal", command: "kill -TERM $$", code: 143 }]),
  ];
  const env = await startPiAimock((mock) => {
    mock.on({ hasToolResult: false }, { toolCalls: [
      ...commands.map(({ id, command }) => ({ id, name: "bash", arguments: JSON.stringify({ command }) })),
      { id: "read_file", name: "read", arguments: JSON.stringify({ path: import.meta.filename }) },
    ] });
    mock.on({ hasToolResult: true }, { content: "done" });
  });
  let session: Session | undefined = undefined;
  try {
    session = await runtimeUnderTest(defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation })).startSession();
    expect(await promptAndWait(session, "run the exit-code checks")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const records = session.records();
    const frames = records.flatMap((record) => record.kind === "frame" && record.body.type === "tool_execution_end" ? [record.body] : []);
    expect(frames).toHaveLength(commands.length + 1);
    for (const { id, code } of commands) {
      const frame = frames.find((body) => asRecord(body.native)?.toolCallId === id);
      const result = asRecord(asRecord(frame?.native)?.result);
      expect(asRecord(result?.structuredContent)?.exit_code).toBe(code);
      expect(frame?.events).toContainEqual(expect.objectContaining({ kind: "tool_call_ended", callId: id, exitCode: code, result: code === 0 ? "ok" : "failed" }));
    }
    const read = frames.find((body) => asRecord(body.native)?.toolCallId === "read_file");
    expect(read?.events).toContainEqual(expect.objectContaining({ kind: "tool_call_ended", callId: "read_file", result: "ok" }));
    expect(read?.events[0]).not.toHaveProperty("exitCode");
    const json = JSON.stringify(records);
    expect(JSON.parse(json)).toEqual(records);
  } finally {
    await session?.dispose();
    await env.stop();
  }
}, 60_000);
