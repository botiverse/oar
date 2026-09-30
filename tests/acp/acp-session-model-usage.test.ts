import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { describe, fixture, start } from "../fixtures/acp-session-support.js";

// A requested model must be confirmed by the agent's own report (issue #22):
// the set_model answer, or a config_option_update pushed while it was asked.
// The fixture accepts any other id with an empty answer and keeps running
// fixture-model-x, the way grok 1.0.12 fell back to its default for a model
// the account cannot use; nothing confirms the switch, so the open is refused.
test.each([
  { name: "a new session", resume: undefined },
  { name: "a resume", resume: "fake-session" },
])("ACP set_model that reports no model refuses the open: $name", async ({ resume }) => {
  await expect(start({}, resume, "requested-y")).rejects.toThrow(
    "session/set_model reported no model, so model requested-y cannot be confirmed",
  );
});

test.each([
  { name: "grok 1.0.44's {Ok: id}", model: "grok-meta" },
  { name: "grok 1.0.12's bare id", model: "grok-meta-legacy" },
])("ACP model read-back takes grok's set_model `_meta.model`: $name", async ({ model }) => {
  const session = await start({}, "fake-session", model);
  assert.equal(session.model().value, model);
  await session.dispose();
});

test("ACP model read-back sees kimi's config_option_update pushed before set_model answers", async () => {
  const session = await start({}, "fake-session", "kimi-push");
  assert.equal(session.model().value, "kimi-push");
  // Both frames are in the stream; the pushed update wins because it is the
  // LATER model report (the SDK may deliver the notification after the
  // set_model answer it was sent before; record order is delivery order).
  const opening = session.records().map((record) => describe(record));
  assert.ok(opening.includes("event session/resume → model:fixture-model-x, effort:medium"), JSON.stringify(opening));
  assert.ok(opening.includes("event config_option_update → model:kimi-push"));
  assert.ok(opening.includes("event session/set_model"));
  assert.ok(opening.indexOf("event config_option_update → model:kimi-push") > opening.indexOf("event session/resume → model:fixture-model-x, effort:medium"));
  await session.dispose();
});

test.each([
  {
    name: "grok's answer names another model",
    model: "grok-substitute",
    message: "session/set_model left the model at grok-default although model grok-substitute was requested",
  },
  {
    name: "kimi's push names another model",
    model: "kimi-substitute",
    message: "session/set_model left the model at kimi-default although model kimi-substitute was requested",
  },
  {
    name: "the agent refuses the id",
    model: "grok-unknown",
    message: "session/set_model grok-unknown was refused: Invalid params (unknown model id)",
  },
])("ACP set_model refuses the resumed open when $name", async ({ model, message }) => {
  await expect(start({}, "fake-session", model)).rejects.toThrow(message);
});

test("ACP model read-back follows config_option_update during a turn", async () => {
  const session = await start();
  assert.equal(session.model().value, "fixture-model-x");
  const run = await promptAndWait(session, "switch-model");
  assert.equal(run.kind, "ended");
  assert.equal(session.model().value, "fixture-model-z");
  await session.dispose();
});

// kimi-code f9ca33376 answers `session/prompt` first and pushes the turn's
// `usage_update` afterwards (acp-server session.ts onTurnEnded →
// void emitUsageUpdate()). The "usage-after-response" fixture mode replays
// that order with `used` = 100 × turn number, so a stale read is visible.
const usageAfterResponse = [fixture, "usage-after-response"];

/** `contextUsage().tokens` as read inside each turn_ended record, in order. */
function tokensAtTurnEnded(session: Session): readonly (number | null)[] {
  const seen: (number | null)[] = [];
  session.rawEvents((record) => {
    if (record.kind === "frame" && record.body.events.some((view) => view.kind === "turn_ended")) {
      seen.push(session.contextUsage().value?.tokens ?? null);
    }
  });
  return seen;
}

async function completedTurn(session: Session, input: string): Promise<void> {
  const run = await promptAndWait(session, input);
  assert.equal(run.kind, "ended");
  assert.deepEqual(run.outcome, { kind: "completed" });
}

async function twoTurns(session: Session): Promise<void> {
  await completedTurn(session, "one");
  await completedTurn(session, "two");
}

test("ACP usageUpdateAfterPrompt (kimi) records the post-response usage_update before the turn end", async () => {
  const session = await start({ args: usageAfterResponse, usageUpdateAfterPrompt: true });
  const atEnd = tokensAtTurnEnded(session);
  await twoTurns(session);
  assert.deepEqual(atEnd, [100, 200]);
  assert.deepEqual(session.contextUsage().value, { tokens: 200, contextWindow: 1000, percent: 20 });
  await session.dispose();
});

test("ACP usageUpdateAfterPrompt records the answer as-is once the bound passes without a usage_update", async () => {
  const session = await start({
    args: [fixture, "usage-never"],
    usageUpdateAfterPrompt: true,
    usageUpdateTimeoutMs: 100,
  });
  const started = performance.now();
  const run = await promptAndWait(session, "one");
  assert.equal(run.kind, "ended");
  assert.ok(performance.now() - started >= 90, "the turn end should have waited for the bound");
  assert.equal(session.contextUsage().value, null);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- the stale-read timeline needs every step.
test("ACP profiles without usageUpdateAfterPrompt (grok) end the turn on the answer and read the previous turn's usage", async () => {
  const session = await start({ args: usageAfterResponse });
  const atEnd = tokensAtTurnEnded(session);
  const first = await promptAndWait(session, "one");
  assert.equal(first.kind, "ended");
  assert.equal(session.contextUsage().value, null);
  await sleep(150);
  assert.deepEqual(session.contextUsage().value, { tokens: 100, contextWindow: 1000, percent: 10 });
  const second = await promptAndWait(session, "two");
  assert.equal(second.kind, "ended");
  assert.deepEqual(atEnd, [null, 100]);
  await session.dispose();
});
