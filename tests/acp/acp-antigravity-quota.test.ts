/* oxlint-disable eslint/max-statements -- Each replay checks its native frames, outcome and accumulated session state together. */
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { opencodeAcpProfile, opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { createAcpTokenUsage, wholePromptTokenUsage } from "../../packages/oar/src/shared/acp/token-usage.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { fixture } from "../fixtures/acp-session-support.js";

// Native agy 1.5.12 Gemini account, 2026-11-19. These are from different turns.
const notice = "\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h30m42s.\n";
const usage = { inputTokens: 192_984, outputTokens: 50_553, cachedReadTokens: 1_559_852, cachedWriteTokens: 0, thoughtTokens: 39_843, totalTokens: 1_803_389 };
const end = { stopReason: "end_turn" };
const message = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const context = (used: number) => ({ sessionUpdate: "usage_update", used, size: 1_048_576 });
const replay = (updates: readonly unknown[], response = end) => `agy-replay:${JSON.stringify({ updates, response })}`;
const open = async () => acpSession({ ...antigravityAcpProfile, args: [fixture, "antigravity"] })(
  { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd(), retainedBytes: 1 },
);

test("only agy's whole native quota notice followed by end_turn without usage fails", async () => {
  const session = await open();
  try {
    const splitNotice = replay([message(notice.slice(0, 30)), message(notice.slice(30))]);
    const run = await promptAndWait(session, splitNotice);
    assert.equal(run.kind, "ended");
    const frame = session.records().findLast(record => record.kind === "frame" && record.body.type === "agent_message_chunk");
    assert.ok(frame);
    expect(run.outcome).toEqual({ kind: "failed", failure: "quota", reason: notice, resetsAt: new Date(frame.receivedAt + 12_642_000).toISOString() });
    expect(session.usage().value.total).toBeNull();
    for (const input of [
      replay([message("Quoted: "), message(notice)]), replay([message(notice), message("\n")]),
      replay([{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } }, message(notice)]),
      replay([{ sessionUpdate: "tool_call", toolCallId: "tool", title: "read" }, message(notice)]),
      replay([message(notice.replace("3h30m42s", "soon"))]), replay([message(notice)], { stopReason: "max_tokens" }),
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each control starts a fresh turn in the same session.
      expect(await promptAndWait(session, input)).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    }
  } finally { await session.dispose(); }
});

test("prompt usage adds each whole turn once, independent of context updates and quota notices", async () => {
  const session = await open();
  try {
    const response = { ...end, usage };
    const tokens = { input: 1_752_836, output: 50_553, cacheRead: 1_559_852, cacheWrite: 0, reasoning: 39_843 };
    const echo = replay([context(9000), message(notice)], response);
    expect(await promptAndWait(session, echo)).toMatchObject({ outcome: { kind: "completed" } });
    expect(session.usage().value.total).toEqual(tokens);
    await promptAndWait(session, replay([context(900), message("ok")], response));
    await promptAndWait(session, replay([message(notice)]));
    expect(session.usage().value.total).toEqual(Object.fromEntries(Object.entries(tokens).map(([key, value]) => [key, value * 2])));
    expect(session.contextUsage().value?.tokens).toBe(900);
  } finally { await session.dispose(); }
});

test("an agy RPC error can carry the same quota deadline in its native error data", async () => {
  const session = await open();
  try {
    const data = notice.trim();
    const run = await promptAndWait(session, `agy-replay:${JSON.stringify({ updates: [], error: { code: -32_603, message: "Request failed", data } })}`);
    assert.equal(run.kind, "ended");
    assert.ok(run.outcome.kind === "failed" && run.outcome.failure === "quota" && run.outcome.resetsAt !== undefined);
    expect(run.outcome.reason).toContain(data);
    const error = session.records().findLast(record => record.kind === "frame" && record.body.type === "session/prompt/error");
    assert.ok(error);
    expect(run.outcome.resetsAt).toBe(new Date(error.receivedAt + 12_642_000).toISOString());
  } finally { await session.dispose(); }
});

test("standard ACP spend requires whole-prompt evidence and preserves unreported parts", () => {
  const response = { usage: { totalTokens: 108, inputTokens: 80, outputTokens: 8 } };
  for (const profile of [opencodeAcpProfile, opencodeV2AcpProfile]) {
    expect(createAcpTokenUsage(profile).prompt(response)).toBeNull();
  }
  expect(wholePromptTokenUsage(response)).toEqual({ input: 100, output: 8 });
  expect(wholePromptTokenUsage({ usage: { ...response.usage, cachedWriteTokens: 11 } })).toEqual({ input: 100, output: 8 });
  expect(wholePromptTokenUsage({ usage: { ...response.usage, totalTokens: 0 } })).toBeNull();
});
