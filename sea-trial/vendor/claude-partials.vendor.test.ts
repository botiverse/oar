import { describe, expect, test, vi } from "vitest";
import type { Event, Frame, Session } from "../../packages/oar/src/contracts/session.js";
import { claudeInstallation, claudeSession, defineRuntime } from "../../packages/oar/src/index.js";
import { stallOf } from "../../packages/oar/src/observe/agent-status.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";

const runtime = defineRuntime({ id: "claude-aimock", installation: claudeInstallation, session: claudeSession });
function nativeContent(session: Session, type: "text" | "thinking"): string {
  return session.records().flatMap((record) => {
    const content = record.kind === "frame" && record.body.type === "assistant" ? asRecord(asRecord(record.body.native)?.message)?.content : null;
    return Array.isArray(content) ? content.map((block) => asRecord(block)).filter((block) => block?.type === type).map((block) => typeof block?.[type] === "string" ? block[type] : "") : [];
  }).join("");
}
const partialEvent = (frame: Frame) => frame.body.type === "stream_event" ? asRecord(asRecord(frame.body.native)?.event) : null;

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude partial messages", () => {
  test("text and thinking are live, name the API message and coalesce without final-block duplication on new and resumed sessions", async () => {
    const answer = "A long reply arrives a few characters at a time, before the completed assistant block.";
    const reasoning = "First consider the question carefully.";
    const env = await startClaudeAimock((mock) => {
      mock.onMessage(/PARTIAL_TEXT/u, { content: answer, reasoning }, { chunkSize: 6, latency: 70 });
    });
    try {
      const subject = runtimeUnderTest(runtime, env.env);
      let resume: string | undefined = undefined;
      for (let round = 0; round < 2; round += 1) {
        const session = await subject.startSession(resume === undefined ? {} : { resume });
        try {
          const events: Event[] = [];
          const coalesced: Event[] = [];
          session.events((event) => { events.push(event); });
          session.events((event) => { coalesced.push(event); }, { coalesceText: true });
          expect(await promptAndWait(session, "PARTIAL_TEXT", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
          const frames = session.records().filter((record): record is Frame => record.kind === "frame");
          const text = events.filter((event) => event.kind === "text_delta");
          const thoughts = events.filter((event) => event.kind === "reasoning" && event.content.kind === "text");
          expect(text.length).toBeGreaterThan(1);
          expect(thoughts.length).toBeGreaterThan(1);
          expect(text.map((event) => event.text).join("")).toBe(answer);
          expect(nativeContent(session, "text")).toBe(answer);
          expect(thoughts.map((event) => event.kind === "reasoning" && event.content.kind === "text" ? event.content.text : "").join("")).toBe(reasoning);
          expect(nativeContent(session, "thinking")).toBe(reasoning);
          expect(new Set([...text, ...thoughts].map((event) => "messageId" in event ? event.messageId : undefined))).toEqual(new Set([text[0]?.messageId]));
          expect(text[0]?.messageId).toBeTruthy();
          const firstComplete = frames.find((frame) => frame.body.type === "assistant");
          expect(thoughts[0]?.seq).toBeLessThan(firstComplete?.seq ?? 0);
          const completeText = frames.find((frame) => frame.body.type === "assistant" && Array.isArray(asRecord(asRecord(frame.body.native)?.message)?.content) && JSON.stringify(asRecord(frame.body.native)?.message).includes(answer));
          expect(text[0]?.seq).toBeLessThan(completeText?.seq ?? 0);
          expect(coalesced.filter((event) => event.kind === "text_delta").map((event) => event.text)).toEqual([answer]);
          expect(frames.filter((frame) => frame.body.type === "assistant").flatMap((frame) => frame.body.events).filter((event) => event.kind === "text_delta" || event.kind === "reasoning")).toEqual([]);
          expect(events.filter((event) => event.kind === "usage")).toHaveLength(1);
          resume = session.id;
        } finally { await session.dispose(); }
      }
    } finally { await env.stop(); }
  }, 90_000);

  test("slow tool arguments keep the stall clock moving without starting a tool twice", async () => {
    const command = 'printf PARTIAL_TOOL_OK';
    const env = await startClaudeAimock((mock) => {
      mock.on({ userMessage: /PARTIAL_TOOL/u, hasToolResult: false }, { toolCalls: [{ id: "call_partial", name: "Bash", arguments: JSON.stringify({ command, description: "A deliberately slowly generated tool input for the progress probe." }) }] }, { chunkSize: 5, latency: 100 });
      mock.on({ hasToolResult: true }, { content: "tool done" });
    });
    try {
      const session = await runtimeUnderTest(runtime, env.env).startSession();
      try {
        const activity: { at: number; stalled: boolean; started: boolean }[] = [];
        session.rawEvents((record) => {
          if (record.kind !== "frame" || asRecord(partialEvent(record)?.delta)?.type !== "input_json_delta") { return; }
          expect(record.body.events).toEqual([]);
          activity.push({ at: record.receivedAt, stalled: stallOf(session.status().value, Date.now(), 500) !== null,
            started: session.records().some((entry) => entry.kind === "frame" && entry.body.events.some((event) => event.kind === "tool_call_started")) });
        });
        expect(await promptAndWait(session, "PARTIAL_TOOL", { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
        expect(activity.length).toBeGreaterThan(2);
        expect((activity.at(-1)?.at ?? 0) - (activity[0]?.at ?? 0)).toBeGreaterThan(500);
        expect(activity.every((sample) => !sample.stalled && !sample.started)).toBe(true);
        const tools = session.records().flatMap((record) => record.kind === "frame" ? record.body.events : []).filter((event) => event.kind === "tool_call_started");
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({ callId: "call_partial", tool: "Bash" });
        expect(JSON.parse(tools[0]?.input ?? "null")).toMatchObject({ command });
      } finally { await session.dispose(); }
    } finally { await env.stop(); }
  }, 60_000);

  test("native background child completed blocks retain attribution after the root result", async () => {
    const env = await startClaudeAimock((mock) => {
      mock.on({ userMessage: /PARENT_PARTIAL/u, hasToolResult: false }, { toolCalls: [{ id: "call_child_partial", name: "Task", arguments: JSON.stringify({ subagent_type: "general-purpose", description: "Partial child probe", prompt: "CHILD_PARTIAL" }) }] });
      mock.onMessage(/CHILD_PARTIAL/u, { content: "CHILD_OUTPUT", reasoning: "Child reasoning." }, { chunkSize: 3, latency: 70 });
      mock.on({ hasToolResult: true }, { content: "PARENT_OUTPUT" });
    });
    try {
      const session = await runtimeUnderTest(runtime, env.env).startSession();
      try {
        const events: Event[] = [];
        session.events((event) => { events.push(event); });
        expect(await promptAndWait(session, "PARENT_PARTIAL", { timeoutMs: 45_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
        // Task may run in the background and finish after the root result.
        await vi.waitFor(() => {
          const completed = session.records().some((record) => record.kind === "frame" && record.agentPath.length > 0 && record.body.type === "assistant" && JSON.stringify(asRecord(record.body.native)?.message).includes("CHILD_OUTPUT"));
          expect(completed).toBe(true);
        }, { timeout: 30_000 });
        const child = events.filter((event) => event.kind === "text_delta" && event.agentPath.length > 0);
        expect(child, JSON.stringify(events)).toHaveLength(1);
        expect(child.map((event) => event.kind === "text_delta" ? event.text : "").join("")).toBe("CHILD_OUTPUT");
        expect(child.every((event) => event.agentPath[0] === "call_child_partial")).toBe(true);
        expect(events.some((event) => event.kind === "text_delta" && event.agentPath.length === 0 && event.text === "PARENT_OUTPUT")).toBe(true);
        const childPartial = session.records().find((record) => record.kind === "frame" && record.body.type === "stream_event" && record.agentPath.length > 0);
        expect(childPartial).toBeUndefined();
      } finally { await session.dispose(); }
    } finally { await env.stop(); }
  }, 60_000);

});
