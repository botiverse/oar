import { expect, test } from "vitest";
import { claudeInstallation, claudeSession, defineRuntime, promptAndWait, type Event, type Session } from "../../packages/oar/src/index.js";
import { initialSessionView, reduceSessionView, viewOf, type SessionView } from "../../packages/oar/src/observe/session-view.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { currentTurnSays, stdioEcho } from "./support/echo-mcp.js";

function tool(view: SessionView, callId: string) {
  return view.messages.flatMap((message) => message.kind === "turn" ? message.sections.flatMap((section) => section.parts) : []).find((part) => part.kind === "tool" && part.callId === callId);
}

async function streamedRound(session: Session, round: number, input: string): Promise<void> {
  const callId = `streamed_echo_${String(round)}`;
  let live = initialSessionView();
  let accumulated = "";
  const events: Event[] = [];
  session.rawEvents((record) => { live = reduceSessionView(live, record); });
  session.events((event) => {
    events.push(event);
    if (event.kind !== "tool_call_input_delta") { return; }
    expect(event.callId).toBe(callId);
    accumulated += event.delta;
    expect(tool(live, callId)).toMatchObject({ input: accumulated, inputPartial: true, result: "running" });
    expect(events.some((entry) => entry.kind === "tool_call_input")).toBe(false);
  });
  expect(await promptAndWait(session, `STREAM_ECHO_${String(round)}`, { timeoutMs: 45_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
  const starts = events.filter((event) => event.kind === "tool_call_started");
  const deltas = events.filter((event) => event.kind === "tool_call_input_delta");
  const completed = events.filter((event) => event.kind === "tool_call_input");
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ callId, tool: "mcp__echo__echo" });
  expect(starts[0]).not.toHaveProperty("input");
  expect(deltas.length).toBeGreaterThan(100);
  expect(completed).toHaveLength(1);
  expect(starts[0]?.seq).toBeLessThan(deltas[0]?.seq ?? 0);
  expect(deltas.at(-1)?.seq).toBeLessThan(completed[0]?.seq ?? 0);
  expect(accumulated).toBe(input);
  expect(completed[0]?.input).toBe(input);
  expect(tool(live, callId)).toMatchObject({ input, result: "ok" });
  expect(tool(live, callId)).not.toHaveProperty("inputPartial");
  expect(live).toEqual(viewOf(session.records()));
}

test.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude streams long MCP input before execution on new and resumed sessions", async () => {
  const input = JSON.stringify({ text: 'a widget line: "你好"\n'.repeat(1000) });
  const env = await startClaudeAimock((mock) => {
    for (let round = 0; round < 2; round += 1) {
      const id = `streamed_echo_${String(round)}`;
      const pattern = new RegExp(`STREAM_ECHO_${String(round)}`, "u");
      mock.on({ predicate: currentTurnSays(pattern), hasToolResult: false }, { toolCalls: [{ id, name: "mcp__echo__echo", arguments: input }] }, { chunkSize: 128, latency: 5 });
      mock.on({ hasToolResult: true, toolCallId: id }, { content: "echo complete" });
    }
  });
  try {
    const runtime = defineRuntime({ id: "claude-aimock", installation: claudeInstallation, session: claudeSession });
    const subject = runtimeUnderTest(runtime, env.env);
    let resume: string | undefined = undefined;
    for (let round = 0; round < 2; round += 1) {
      const session = await subject.startSession({ mcpServers: [stdioEcho("echo")], ...(resume === undefined ? {} : { resume }) });
      try { await streamedRound(session, round, input); resume = session.id; }
      finally { await session.dispose(); }
    }
  } finally { await env.stop(); }
}, 120_000);
