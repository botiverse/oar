import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { RawEvent, RuntimeEventBody } from "../../packages/oar/src/index.js";
import { viewOf, type SessionView, type ViewPart } from "../../packages/oar/src/observe/session-view.js";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

/**
 * Issue #82 from a REAL codex recording (oar RawEvent records, scrubbed):
 * the user prompts `sleep 100`, then steers `test 1`, `test 2` and `test 3`
 * while the agent sleeps. Codex holds a steer until its current step ends,
 * so each input belongs where its `userMessage` item shows codex took it,
 * and each `agentMessage` item is its own text. The waits are `sleep` tool
 * calls (#84). The recording predates
 * `text_delta.messageId`, so every notification frame is read again through
 * today's codex projection, as a live session would record it.
 */

const here = import.meta.dirname;

function isRawEvent(value: unknown): value is RawEvent {
  const record = asRecord(value);
  return typeof record?.kind === "string" && typeof record.seq === "number" && typeof record.sessionId === "string";
}

function recorded(): RawEvent[] {
  return readFileSync(path.join(here, "fixtures", "codex-steer-order.records.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line): unknown => JSON.parse(line))
    .filter((record) => isRawEvent(record));
}

/** Frames re-read by the codex projection; one whose native the scrub emptied (usage, the open, the turn end) keeps its recorded events. */
function reread(records: readonly RawEvent[]): RawEvent[] {
  const root = records[0]?.sessionId ?? "";
  let state = initialCodexProjection(root);
  return records.map((record) => {
    const params = record.kind === "frame" ? asRecord(record.body.native) : null;
    if (record.kind !== "frame" || params === null || Object.keys(params).length === 0) {
      return record;
    }
    const folded = foldCodexNotification(state, record.body.type, params);
    ({ state } = folded);
    const [command] = folded.commands;
    return command?.kind === "frame" ? { ...record, body: command.body } : record;
  });
}

function partLine(part: ViewPart): string {
  if (part.kind === "text") {
    return `text ${part.text}`;
  }
  return part.kind === "tool" ? `tool ${part.tool} ${part.input ?? ""}`.trim() : part.kind;
}

function outline(view: SessionView): string[] {
  const lines = view.messages.flatMap((message) => {
    switch (message.kind) {
      case "input":
        return [`input ${message.input.input}`];
      case "turn":
        return [
          `turn${message.outcome === undefined ? "" : ` (${message.outcome.kind})`}`,
          ...message.sections.flatMap((section) => section.parts.map((part) => `  ${partLine(part)}`)),
        ];
      case "notice":
        return [`notice ${message.notice.cause}`];
    }
    return [];
  });
  return [...lines, `pending [${view.pendingInputs.map((input) => input.input).join(", ")}]`];
}

test("codex steers enter where codex took them, and each agentMessage is its own text part", () => {
  const records = reread(recorded());
  expect(outline(viewOf(records))).toMatchInlineSnapshot(`
    [
      "input sleep 100",
      "turn",
      "  text 好，我等 100 秒。",
      "  tool sleep {"durationMs":50000}",
      "input test 1",
      "turn",
      "  text 收到“test 1”。刚才的等待被新消息打断了，我会继续等满剩余时间。",
      "  tool sleep {"durationMs":50000}",
      "input test 2",
      "input test 3",
      "turn (completed)",
      "  text 收到“test 2”和“test 3”。我继续按最初的要求等待。",
      "  tool sleep {"durationMs":50000}",
      "  tool sleep {"durationMs":42500}",
      "  text 已等待约 100 秒，也收到了你的三条测试消息。",
      "pending []",
    ]
  `);
});

test("steers codex has not taken yet wait in pendingInputs", () => {
  const records = reread(recorded());
  // Up to the test 3 steer's acceptance: codex has taken test 1, not test 2 or 3.
  const upTo = records.findIndex((record) => record.kind === "response" && record.seq === 37);
  const view = viewOf(records.slice(0, upTo + 1));
  expect(outline(view)).toMatchInlineSnapshot(`
    [
      "input sleep 100",
      "turn",
      "  text 好，我等 100 秒。",
      "  tool sleep {"durationMs":50000}",
      "input test 1",
      "pending [test 2, test 3]",
    ]
  `);
});

type TextDelta = Extract<RuntimeEventBody, { kind: "text_delta" }>;

function textsOf(records: readonly RawEvent[]): TextDelta[] {
  return records.flatMap((record) => (record.kind === "frame"
    ? record.body.events.filter((event): event is TextDelta => event.kind === "text_delta")
    : []));
}

test("re-reading gives the recorded text each its agentMessage id; folding the log twice changes nothing", () => {
  const original = recorded();
  const records = reread(original);
  const texts = textsOf(records);
  expect(texts.map(({ messageId: _messageId, ...text }) => text)).toEqual(textsOf(original));
  expect(new Set(texts.map((text) => text.messageId ?? "none")).size).toBe(4);
  const once = viewOf(records);
  const twice = viewOf([...records, ...records]);
  expect(twice.messages).toEqual(once.messages);
  expect(twice.pendingInputs).toEqual(once.pendingInputs);
});

function deltaEvents(params: Record<string, unknown>): unknown {
  const [command] = foldCodexNotification(initialCodexProjection("thread-root"), "item/agentMessage/delta", params).commands;
  return command?.kind === "frame" ? command.body.events : null;
}

test("codex agentMessage deltas name their item as the text's messageId", () => {
  expect(deltaEvents({ threadId: "thread-root", turnId: "t1", itemId: "msg_1", delta: "hi" })).toEqual([{ kind: "text_delta", text: "hi", messageId: "msg_1" }]);
  expect(deltaEvents({ threadId: "thread-root", turnId: "t1", delta: "hi" })).toEqual([{ kind: "text_delta", text: "hi" }]);
});
