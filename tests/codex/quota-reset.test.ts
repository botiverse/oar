import { expect, test } from "vitest";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";
import type { TurnOutcome } from "../../packages/oar/src/contracts/session.js";

type Notice = readonly [string, JsonRecord];
const start = (id = "current", threadId = "root"): Notice => ["turn/started", { threadId, turn: { id } }];
const finish = (id = "current", codexErrorInfo = "usageLimitExceeded", threadId = "root"): Notice => ["turn/completed", { threadId, turn: { id, status: "failed", error: { codexErrorInfo, message: "native" } } }];
const exhausted: JsonRecord = { usedPercent: 100, resetsAt: 1_900_000_000 };
const reset = (primary: JsonRecord | null = exhausted, secondary: JsonRecord | null = null): Notice => ["account/rateLimits/updated", { rateLimits: { limitId: "codex", primary, secondary } }];

function outcome(notices: readonly Notice[]): TurnOutcome | undefined {
  let state = initialCodexProjection("root");
  const outcomes: TurnOutcome[] = [];
  for (const [method, params] of notices) {
    const { state: next, commands } = foldCodexNotification(state, method, params);
    state = next;
    const events = commands.flatMap(command => command.kind === "frame" ? command.body.events : []);
    outcomes.push(...events.flatMap(event => event.kind === "turn_ended" ? [event.outcome] : []));
  }
  return outcomes.at(-1);
}

test.each<{ name: string; notices: readonly Notice[] }>([
  { name: "idle snapshot", notices: [reset(), start(), finish()] },
  { name: "previous turn", notices: [start("old"), reset(), finish("old"), start(), finish()] },
  { name: "replaced turn", notices: [start("old"), reset(), start(), finish()] },
  { name: "different completion id", notices: [start(), reset(), finish("different")] },
  { name: "new empty snapshot", notices: [start(), reset(), reset(null), finish()] },
  { name: "non-exhausted window", notices: [start(), reset({ usedPercent: 99, resetsAt: 1_900_000_000 }), finish()] },
  { name: "missing reset", notices: [start(), reset({ usedPercent: 100 }), finish()] },
  { name: "invalid reset", notices: [start(), reset({ usedPercent: 100, resetsAt: 1e100 }), finish()] },
  { name: "conflicting exhausted windows", notices: [start(), reset({ usedPercent: 100, resetsAt: 1_900_000_000 }, { usedPercent: 100, resetsAt: 1_900_003_600 }), finish()] },
  { name: "reset missing from second exhausted window", notices: [start(), reset({ usedPercent: 100, resetsAt: 1_900_000_000 }, { usedPercent: 100 }), finish()] },
  { name: "child thread notification", notices: [start(), reset(), ["thread/started", { thread: { id: "child" } }], finish()] },
  { name: "child starts", notices: [start(), reset(), start("child-turn", "child"), finish()] },
  { name: "child has already ended", notices: [start("child-turn", "child"), finish("child-turn", "usageLimitExceeded", "child"), start(), reset(), finish()] },
  { name: "collaboration item", notices: [start(), reset(), ["item/started", { threadId: "root", item: { type: "collabAgentToolCall" } }], finish()] },
  { name: "automatic compaction", notices: [start(), reset(), ["item/started", { threadId: "root", item: { type: "contextCompaction" } }], finish()] },
  { name: "snapshot after terminal error", notices: [start(), ["error", { threadId: "root", turnId: "current", willRetry: false, error: {} }], reset(), finish()] },
])("does not attach a reset from $name", ({ notices }) => {
  expect(outcome(notices)).toMatchObject({ kind: "failed", failure: "quota" });
  expect(outcome(notices)).not.toHaveProperty("resetsAt");
});

test("a full current-turn window does not classify an unknown streamed failure", () => {
  expect(outcome([start(), reset(), finish("current", "other")])).toMatchObject({ kind: "failed", failure: "unknown" });
  expect(outcome([start(), reset(), finish("current", "other")])).not.toHaveProperty("resetsAt");
});

test("keeps the pre-error snapshot when another update arrives after failure", () => {
  expect(outcome([start(), reset(), ["error", { threadId: "root", turnId: "current", willRetry: false, error: {} }], reset(null), finish()]))
    .toMatchObject({ kind: "failed", failure: "quota", resetsAt: "2030-03-17T17:46:40.000Z" });
});

test("uses the only exhausted window, including secondary", () => {
  expect(outcome([start(), reset({ usedPercent: 25, resetsAt: 1_899_996_400 }, { usedPercent: 100, resetsAt: 1_900_000_000 }), finish()]))
    .toHaveProperty("resetsAt", "2030-03-17T17:46:40.000Z");
});
