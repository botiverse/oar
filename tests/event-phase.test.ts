import { expect, test } from "vitest";
import { coalesceText } from "../packages/oar/src/observe/events.js";
import type { Event } from "../packages/oar/src/index.js";

test("coalesceText preserves native phase boundaries, including an absent phase", () => {
  const seen: Event[] = [];
  const observer = coalesceText(item => { seen.push(item); });
  const envelope = { sessionId: "root", agentPath: [], seq: 1, receivedAt: 0 };
  for (const [text, phase] of [["unknown", undefined], ["first", "commentary"], [" second", "commentary"], ["answer", "final_answer"], ["unknown again", undefined]] as const) {
    observer({ ...envelope, kind: "text_delta", messageId: "message", text, ...(phase === undefined ? {} : { phase }) });
  }
  observer({ ...envelope, kind: "turn_ended", outcome: { kind: "completed" } });
  expect(seen.filter(item => item.kind === "text_delta").map(item => ({ text: item.text, phase: item.phase }))).toEqual([
    { text: "unknown", phase: undefined }, { text: "first second", phase: "commentary" },
    { text: "answer", phase: "final_answer" }, { text: "unknown again", phase: undefined },
  ]);
});
