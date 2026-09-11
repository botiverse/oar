import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { describe, fixture, start } from "../fixtures/acp-session-support.js";

// The read-back must be the runtime's word, never the request parameter. The
// fixture accepts any `session/set_model` with an empty answer but keeps
// running fixture-model-x, the way grok falls back to its default for a model
// the account cannot use.
test("ACP model read-back reports the agent's effective model, not the requested one", async () => {
  const requested = await start({}, undefined, "requested-y");
  assert.equal(requested.model(), "fixture-model-x");
  await requested.dispose();

  const resumed = await start({}, "fake-session", "requested-y");
  assert.equal(resumed.model(), "fixture-model-x");
  await resumed.dispose();
});

test("ACP model read-back takes grok's set_model `_meta.model` over the session/new report", async () => {
  const session = await start({}, undefined, "grok-meta");
  assert.equal(session.model(), "grok-applied");
  await session.dispose();
});

test("ACP model read-back sees kimi's config_option_update pushed before set_model answers", async () => {
  const session = await start({}, undefined, "kimi-push");
  assert.equal(session.model(), "kimi-pushed");
  // Both frames are in the stream; the pushed update wins because it is the
  // LATER model report (the SDK may deliver the notification after the
  // set_model answer it was sent before — record order is delivery order).
  const opening = session.records().map((record) => describe(record));
  assert.ok(opening.includes("event session/new → model:fixture-model-x"));
  assert.ok(opening.includes("event config_option_update → model:kimi-pushed"));
  assert.ok(opening.includes("event session/set_model"));
  assert.ok(opening.indexOf("event config_option_update → model:kimi-pushed") > opening.indexOf("event session/new → model:fixture-model-x"));
  await session.dispose();
});

test("ACP model read-back follows config_option_update during a turn", async () => {
  const session = await start();
  assert.equal(session.model(), "fixture-model-x");
  const run = await promptAndWait(session, "switch-model");
  assert.equal(run.kind, "ended");
  assert.equal(session.model(), "fixture-model-z");
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
  session.subscribe((record) => {
    if (record.kind === "event" && record.body.views.some((view) => view.kind === "turn_ended")) {
      seen.push(session.contextUsage()?.tokens ?? null);
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
  assert.deepEqual(session.contextUsage(), { tokens: 200, contextWindow: 1000, percent: 20 });
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
  assert.equal(session.contextUsage(), null);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- the stale-read timeline needs every step.
test("ACP profiles without usageUpdateAfterPrompt (grok) end the turn on the answer and read the previous turn's usage", async () => {
  const session = await start({ args: usageAfterResponse });
  const atEnd = tokensAtTurnEnded(session);
  const first = await promptAndWait(session, "one");
  assert.equal(first.kind, "ended");
  assert.equal(session.contextUsage(), null);
  await sleep(150);
  assert.deepEqual(session.contextUsage(), { tokens: 100, contextWindow: 1000, percent: 10 });
  const second = await promptAndWait(session, "two");
  assert.equal(second.kind, "ended");
  assert.deepEqual(atEnd, [null, 100]);
  await session.dispose();
});
