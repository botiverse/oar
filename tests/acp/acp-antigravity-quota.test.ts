/* oxlint-disable eslint/max-statements -- Each replay checks its native frames, outcome and accumulated session state together. */
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import type { RawEvent } from "../../packages/oar/src/contracts/session.js";
import { antigravityQuotaNotice } from "../../packages/oar/src/runtimes/antigravity/quota.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { opencodeAcpProfile, opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { createAcpTokenUsage, wholePromptTokenUsage } from "../../packages/oar/src/shared/acp/token-usage.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { fixture } from "../fixtures/acp-session-support.js";

// Native agy 1.5.12/1.5.13 Gemini accounts, 2026-11-19.
const notice = "\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h30m42s.\n";
const midTurnNotice = "\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h28m25s.\n";
const usage = { inputTokens: 192_984, outputTokens: 50_553, cachedReadTokens: 1_559_852, cachedWriteTokens: 0, thoughtTokens: 39_843, totalTokens: 1_803_389 };
const midTurnUsage = { inputTokens: 20_806, outputTokens: 2059, cachedReadTokens: 1_342_076, cachedWriteTokens: 0, thoughtTokens: 1355, totalTokens: 1_364_941 };
const end = { stopReason: "end_turn" };
const message = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const thought = (text: string) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const context = (used: number) => ({ sessionUpdate: "usage_update", used, size: 1_048_576 });
const toolStart = (id: string) => ({ sessionUpdate: "tool_call", toolCallId: id, name: "read_file", status: "in_progress", title: "read" });
const toolDone = (id: string) => ({ sessionUpdate: "tool_call_update", toolCallId: id, name: "read_file", status: "completed", title: "read" });
const replay = (updates: readonly unknown[], response: Record<string, unknown> = end) => `agy-replay:${JSON.stringify({ updates, response })}`;
const open = async () => acpSession({ ...antigravityAcpProfile, args: [fixture, "antigravity"] })(
  { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd(), retainedBytes: 1 },
);

test("only agy's whole native quota notice without trailing model usage fails at turn start", async () => {
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
      replay([thought("thinking"), message(notice)]),
      replay([message(notice), context(108)]),
      replay([message(notice.replace("3h30m42s", "soon"))]), replay([message(notice)], { stopReason: "max_tokens" }),
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each control starts a fresh turn in the same session.
      expect(await promptAndWait(session, input)).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    }
  } finally { await session.dispose(); }
});

test("mid-turn quota notice after tool work fails with resetsAt and preserves earlier spend", async () => {
  const session = await open();
  try {
    // Recorded agy 1.5.13 mid-turn quota tail (2026-11-19): prior thought, usage_update, tool call, then notice and end_turn with prior spend.
    const recorded = replay(
      [thought("checking"), context(200_404), toolStart("call_1"), toolDone("call_1"), message(midTurnNotice)],
      { ...end, usage: midTurnUsage },
    );
    const run = await promptAndWait(session, recorded);
    assert.equal(run.kind, "ended");
    const frame = session.records().findLast(record => record.kind === "frame" && record.body.type === "agent_message_chunk");
    assert.ok(frame);
    expect(run.outcome).toEqual({ kind: "failed", failure: "quota", reason: midTurnNotice, resetsAt: new Date(frame.receivedAt + 5_305_000).toISOString() });
    expect(session.usage().value.total).toEqual({ input: 1_362_882, output: 2059, cacheRead: 1_342_076, cacheWrite: 0, reasoning: 1355 });
    expect(session.contextUsage().value?.tokens).toBe(200_404);
    const afterEarlierText = replay([message("Checking..."), context(100), toolStart("call_2"), toolDone("call_2"), message(midTurnNotice)], { ...end, usage: midTurnUsage });
    expect(await promptAndWait(session, afterEarlierText)).toMatchObject({ kind: "ended", outcome: { kind: "failed", failure: "quota" } });
    const afterToolNoUsage = replay([toolStart("call_3"), toolDone("call_3"), message(midTurnNotice)]);
    expect(await promptAndWait(session, afterToolNoUsage)).toMatchObject({ kind: "ended", outcome: { kind: "failed", failure: "quota" } });
  } finally { await session.dispose(); }
});

test("model text echoing the quota notice after tool work stays completed", async () => {
  const session = await open();
  try {
    const withUsage = { ...end, usage: midTurnUsage };
    for (const input of [
      // Loopback agy 1.5.13 control: model echoes exact notice after a tool and emits trailing usage_update.
      replay([context(108), toolStart("c1"), toolDone("c1"), message(notice), context(158)], withUsage),
      replay([toolStart("c2"), toolDone("c2"), thought("quoting"), message(notice)], withUsage),
      replay([toolStart("c3"), toolDone("c3"), message("Warning: "), message(notice)], withUsage),
      replay([message(notice), toolStart("c4"), toolDone("c4")], withUsage),
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each control starts a fresh turn in the same session.
      expect(await promptAndWait(session, input)).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    }
  } finally { await session.dispose(); }
});

test("superseded steer prompt resets the prompt-usage window before evaluating quota notice", () => {
  const receivedAt = 1_795_088_800_000;
  const frame = (seq: number, type: string, text?: string): RawEvent => ({
    sessionId: "s", agentPath: [], seq, receivedAt, kind: "frame",
    body: { type, native: {}, events: text === undefined ? [] : [{ kind: "text_delta", text }] },
  });
  const steeredQuota: RawEvent[] = [
    frame(1, "tool_call"), frame(2, "session/prompt"), frame(3, "tool_call_update"), frame(4, "agent_message_chunk", midTurnNotice),
  ];
  expect(antigravityQuotaNotice(end, () => steeredQuota)).toEqual({
    kind: "failed", failure: "quota", reason: midTurnNotice, resetsAt: new Date(receivedAt + 5_305_000).toISOString(),
  });
  const steeredEcho: RawEvent[] = [frame(1, "tool_call"), frame(2, "session/prompt"), frame(3, "agent_message_chunk", midTurnNotice)];
  expect(antigravityQuotaNotice({ ...end, usage: midTurnUsage }, () => steeredEcho)).toBeNull();
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
