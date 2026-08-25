import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { SessionEvent } from "../../packages/oar/src/contracts/session.js";
import { ingestClaudeLine, type ClaudeProjectionState } from "../../packages/oar/src/runtimes/claude/projection.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

/**
 * Record/replay: feed a REAL recorded claude stdout stream (fixtures/*.raw.jsonl,
 * captured from a live login and scrubbed to the fields we consume) through the
 * production projection seam, and snapshot the SessionEvents it emits. This is
 * the living "what the provider sends → how we project it" specimen, and a
 * regression net: if claude changes its wire shape or we change the mapping,
 * the snapshot moves and a human confirms it.
 */

const here = import.meta.dirname;

function replay(fixture: string): { raw: string[]; projected: string[] } {
  const lines = readFileSync(path.join(here, "fixtures", fixture), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const kernel = createSessionKernel("replay");
  const events: SessionEvent[] = [];
  kernel.subscribe((event) => {
    events.push(event);
  });
  // A recorded stream opens with system/init; the live adapter begins the
  // first turn on the prompt write, so seed one turn to stand in for it.
  const state: ClaudeProjectionState = { turn: kernel.begin(), abortPending: false };
  for (const line of lines) {
    ingestClaudeLine(kernel, state, line);
  }
  return {
    raw: lines.map((line) => summarizeRaw(parseFrame(line))),
    projected: events.map((event) => summarizeEvent(event)),
  };
}

interface RawFrame { type?: string; subtype?: string; message?: { content?: { type?: string }[] } }

function parseFrame(line: string): RawFrame {
  const parsed: unknown = JSON.parse(line);
  return typeof parsed === "object" && parsed !== null ? parsed : {};
}

function summarizeRaw(message: RawFrame): string {
  const blocks = message.message?.content?.map((block) => block.type).join(",") ?? "";
  return [message.type, message.subtype, blocks].filter((part) => part !== undefined && part !== "").join(" ");
}

function summarizeEvent(event: SessionEvent): string {
  if (event.kind === "tool_call_started") {
    return `tool_call_started ${event.tool}`;
  }
  if (event.kind === "reasoning") {
    return `reasoning ${event.content.kind}`;
  }
  if (event.kind === "turn_ended") {
    return `turn_ended ${event.outcome.kind}`;
  }
  return event.kind;
}

test("claude tool-round: recorded stdout projects to the expected SessionEvents", () => {
  const { raw, projected } = replay("claude-tool-round.raw.jsonl");
  // Left: the raw claude frames we consumed. Right: our projection.
  expect({ raw, projected }).toMatchInlineSnapshot(`
    {
      "projected": [
        "turn_started",
        "reasoning text",
        "tool_call_started Bash",
        "tool_call_ended",
        "reasoning text",
        "text_delta",
        "turn_ended completed",
      ],
      "raw": [
        "system init",
        "system thinking_tokens",
        "system thinking_tokens",
        "system thinking_tokens",
        "system thinking_tokens",
        "assistant thinking",
        "assistant tool_use",
        "user tool_result",
        "system thinking_tokens",
        "system thinking_tokens",
        "system thinking_tokens",
        "assistant thinking",
        "assistant text",
        "result success",
      ],
    }
  `);
});
