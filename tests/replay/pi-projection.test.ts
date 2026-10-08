import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import {
  foldPiEvent,
  initialPiProjection,
  piPrompted,
  type PiProjectionState,
  type ProjectionCommand,
} from "../../packages/oar/src/runtimes/pi/projection.js";
import type { TokenTotals } from "../../packages/oar/src/contracts/session.js";
import { parseJson } from "../../packages/oar/src/shared/json.js";

/**
 * Record/replay for pi. pi has no bare-metal provider here, so the fixture is
 * REAL pi SDK events recorded with a scripted provider (pi-aimock): same
 * fidelity as the pi-aimock behavior tests; the event SHAPES are pi's own.
 * The recorded events fold through the production projection; the
 * type|record table snapshots to a FILE beside the input. Every SDK event
 * yields exactly one event record (nothing is dropped); the events column
 * is what oar read out of it.
 */

const here = import.meta.dirname;
const scenarios = ["tool-round", "mcp-echo"];

function describeUsage(tokens: TokenTotals | undefined): string {
  if (tokens === undefined) {
    return "usage";
  }
  const parts = [
    ...(tokens.cacheRead === undefined ? [] : [` cacheRead=${String(tokens.cacheRead)}`]),
    ...(tokens.cacheWrite === undefined ? [] : [` cacheWrite=${String(tokens.cacheWrite)}`]),
  ];
  return `usage in=${String(tokens.input)} out=${String(tokens.output)}${parts.join("")}`;
}

function describeCommand(command: ProjectionCommand): string {
  const events = command.body.events.map((view) => {
    if (view.kind === "tool_call_started") {
      return `tool_call_started ${view.tool}`;
    }
    if (view.kind === "reasoning") {
      return `reasoning ${view.content.kind}`;
    }
    if (view.kind === "turn_ended") {
      return `turn_ended ${view.outcome.kind}`;
    }
    if (view.kind === "usage") {
      return describeUsage(view.usage.tokens);
    }
    return view.kind;
  });
  return `event${events.length === 0 ? "" : ` → ${events.join(", ")}`}`;
}

function parseEvent(line: string): AgentSessionEvent {
  // oxlint-disable-next-line consistent-type-assertions, no-unsafe-type-assertion -- the fixture is a recorded pi SDK event stream, replayed verbatim
  return parseJson(line) as AgentSessionEvent;
}

function foldLine(state: PiProjectionState, line: string): { state: PiProjectionState; row: string } {
  const event = parseEvent(line);
  const { state: next, commands } = foldPiEvent(state, event);
  const produced = commands.map((command) => describeCommand(command)).join(", ") || "-";
  const label = event.type === "message_update" ? `${event.type}:${event.assistantMessageEvent.type}` : event.type;
  return { state: next, row: `${label.padEnd(30)} │ ${produced}` };
}

function foldFixture(lines: readonly string[]): string {
  let state = piPrompted(initialPiProjection);
  const rows: string[] = [];
  for (const line of lines) {
    const { state: next, row } = foldLine(state, line);
    state = next;
    rows.push(row);
  }
  return `${rows.join("\n")}\n`;
}

function toolEndEvent(toolCallId: string, isError: boolean): AgentSessionEvent {
  return { type: "tool_execution_end", toolCallId, toolName: "bash", result: "boom", isError };
}

for (const scenario of scenarios) {
  test(`pi ${scenario}: recorded SDK events fold to the expected records`, async () => {
    const lines = readFileSync(path.join(here, "fixtures", `pi-${scenario}.raw.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    await expect(foldFixture(lines)).toMatchFileSnapshot(
      path.join(here, "fixtures", `pi-${scenario}.projected.txt`),
    );
  });
}

test("pi agent_settled carries the adapter-supplied context and classifies abort and provider errors", () => {
  const agentEnd: AgentSessionEvent = { type: "agent_settled", aborted: false };
  const context = { tokens: 42, contextWindow: 1000, percent: 4 };
  const completed = foldPiEvent(piPrompted(initialPiProjection), agentEnd, { context });
  expect(completed.commands[0]?.body.events).toEqual([
    { kind: "turn_ended", outcome: { kind: "completed" } },
    { kind: "usage", usage: { context } },
  ]);
  const aborted = foldPiEvent(piPrompted(initialPiProjection), { type: "agent_settled", aborted: true });
  expect(aborted.commands[0]?.body.events).toEqual([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
  const errored = foldPiEvent(piPrompted(initialPiProjection), {
    type: "turn_end",
    // oxlint-disable-next-line consistent-type-assertions, no-unsafe-type-assertion -- only the fields the fold reads matter here
    message: { role: "assistant", stopReason: "error", errorMessage: "400 bad request" } as never,
    toolResults: [],
  });
  const ended = foldPiEvent(errored.state, agentEnd);
  expect(ended.commands[0]?.body.events[0]).toEqual({
    kind: "turn_ended",
    outcome: { kind: "failed", reason: "400 bad request", failure: "invalid_request", status: 400 },
  });
});

test("pi's native aborted flag takes precedence over a provider's abort error", () => {
  const failed = foldPiEvent(initialPiProjection, {
    type: "turn_end",
    // oxlint-disable-next-line consistent-type-assertions, no-unsafe-type-assertion -- only the fields the fold reads matter here
    message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" } as never,
    toolResults: [],
  });
  const result = foldPiEvent(failed.state, { type: "agent_settled", aborted: true });
  expect(result.commands[0]?.body.events).toEqual([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
});

/**
 * An assistant `message_end` with pi-ai 1.0.4's `Usage` (types.d.ts: `input`
 * excludes `cacheRead` and `cacheWrite`; `cacheWrite1h` is a subset of
 * `cacheWrite`), the shape recorded in fixtures/pi-tool-round.raw.jsonl.
 */
function assistantEnd(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number }): AgentSessionEvent {
  // oxlint-disable-next-line consistent-type-assertions, no-unsafe-type-assertion -- only the fields the fold reads matter here
  return { type: "message_end", message: { role: "assistant", usage: { ...usage, totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite } } } as never;
}

// #161: pi's cacheRead / cacheWrite are parts of input, accumulated like it
// across turns (agent_settled ends one; the running total stays).
test("pi cache reads and writes accumulate across turns as parts of input", () => {
  let state = piPrompted(initialPiProjection);
  const totals: unknown[] = [];
  for (const event of [
    assistantEnd({ input: 1381, output: 39, cacheRead: 0, cacheWrite: 5120, cacheWrite1h: 5120 }),
    { type: "agent_settled", aborted: false } satisfies AgentSessionEvent,
    assistantEnd({ input: 12, output: 40, cacheRead: 5120, cacheWrite: 1395 }),
  ]) {
    const { state: next, commands } = foldPiEvent(state, event);
    state = next;
    totals.push(...commands.flatMap((command) => command.body.events.flatMap((view) => (view.kind === "usage" && view.usage.tokens !== undefined ? [view.usage.tokens] : []))));
  }
  expect(totals).toEqual([
    { input: 6501, output: 39, cacheRead: 0, cacheWrite: 5120 },
    { input: 13_028, output: 79, cacheRead: 5120, cacheWrite: 6515 },
  ]);
});

test("pi tool_execution_end maps the explicit isError flag", () => {
  const failed = foldPiEvent(piPrompted(initialPiProjection), toolEndEvent("tool-fail", true));
  expect(failed.commands[0]?.body.events).toEqual([
    { kind: "tool_call_ended", callId: "tool-fail", content: [{ type: "text", text: "boom" }], result: "failed" },
  ]);
  const successful = foldPiEvent(piPrompted(initialPiProjection), toolEndEvent("tool-success", false));
  expect(successful.commands[0]?.body.events).toEqual([
    { kind: "tool_call_ended", callId: "tool-success", content: [{ type: "text", text: "boom" }], result: "ok" },
  ]);
});

const fold = (state: PiProjectionState, event: AgentSessionEvent): { state: PiProjectionState; events: unknown } => {
  const { state: next, commands } = foldPiEvent(state, event);
  return { state: next, events: commands.map((command) => command.body.events) };
};

test("pi compaction events carry pi's own trigger and failure reason", () => {
  const state = piPrompted(initialPiProjection);
  const started = fold(state, { type: "compaction_start", reason: "threshold" });
  const failed = fold(started.state, { type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: true, errorMessage: "summary call failed" });
  const aborted = fold(failed.state, { type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
  expect([started.events, failed.events, aborted.events]).toMatchInlineSnapshot(`
    [
      [
        [
          {
            "kind": "compaction_started",
            "trigger": "threshold",
          },
        ],
      ],
      [
        [
          {
            "kind": "compaction_ended",
            "outcome": "failed",
            "reason": "summary call failed",
            "trigger": "threshold",
          },
        ],
      ],
      [
        [
          {
            "kind": "compaction_ended",
            "outcome": "aborted",
            "trigger": "manual",
          },
        ],
      ],
    ]
  `);
});

test("pi retry and tool progress events", () => {
  const state = piPrompted(initialPiProjection);
  const retry = fold(state, { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1500, errorMessage: "overloaded" });
  const progress = fold(retry.state, { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "half" }], details: {} } });
  expect([retry.events, progress.events]).toMatchInlineSnapshot(`
    [
      [
        [
          {
            "attempt": 2,
            "delayMs": 1500,
            "kind": "retry",
            "maxAttempts": 3,
            "reason": "overloaded",
          },
        ],
      ],
      [
        [
          {
            "callId": "call_1",
            "kind": "tool_call_progress",
            "output": "{"content":[{"type":"text","text":"half"}],"details":{}}",
          },
        ],
      ],
    ]
  `);
});
