import { afterEach, expect, test, vi } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { claudeFailure } from "../../packages/oar/src/runtimes/claude/failure.js";
import { claudePrompted, foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { utcInstantFromDate } from "../../packages/oar/src/shared/instant.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

/*
 * A claude.ai subscription's limit (docs/spec/runtime-matrix.md#when-a-limit-resets):
 * claude reports each change of its limits as a `rate_limit_event`, the
 * refusal's before the turn's error frame and result. Shapes from Agent SDK
 * 0.3.295 `SDKRateLimitInfo` and the claude 2.1.289 binary; no run has
 * observed one (it needs a subscription at its limit).
 */

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.289" } as const;
afterEach(() => { spawnLineProcess.mockReset(); });

const RESET = 1_791_558_000; // 2026-10-09T15:00:00Z, in unix seconds as claude sends it
const RESET_AT = "2026-10-09T15:00:00.000Z";
const limitText = "You've hit your session limit · resets 3pm";

function rateLimitEvent(info: Record<string, unknown>): Record<string, unknown> {
  return { type: "rate_limit_event", rate_limit_info: info, uuid: "00000000-0000-4000-8000-000000000000", session_id: "s" };
}
const rejected = rateLimitEvent({ status: "rejected", resetsAt: RESET, rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false });
const refusedTurn = [
  { type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: limitText }] } },
  { type: "result", subtype: "success", is_error: true, api_error_status: 429, terminal_reason: "api_error", result: limitText },
];
const refused = { kind: "failed", reason: limitText, failure: "rate_limited", status: 429 };

/** The turn outcomes the frames fold to, in order. */
function outcomesOf(frames: readonly Record<string, unknown>[]): unknown[] {
  const outcomes: unknown[] = [];
  let state = claudePrompted(initialClaudeProjection);
  for (const frame of frames) {
    const { state: next, commands } = foldClaudeStdout(state, frame);
    state = next;
    for (const command of commands) {
      const ended = command.kind === "frame" ? command.body.events.find((view) => view.kind === "turn_ended") : undefined;
      if (ended?.kind === "turn_ended") { outcomes.push(ended.outcome); }
    }
  }
  return outcomes;
}

/** A claude session on a fake process, and a way to make it print frames. */
async function opened(): Promise<{ session: Awaited<ReturnType<typeof claudeSession>>; emit: (frames: readonly Record<string, unknown>[]) => void }> {
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  return { session, emit: (frames) => { child.emit(frames.map((frame) => `${JSON.stringify(frame)}\n`).join("")); } };
}

test("a turn a subscription limit refused ends with the reset claude's rejected rate_limit_event reports", async () => {
  const { session, emit } = await opened();
  const first = await session.prompt("go on");
  emit([rateLimitEvent({ status: "allowed_warning", resetsAt: RESET, rateLimitType: "five_hour", utilization: 0.9 }), rejected, ...refusedTurn]);
  expect(await awaitTurnEnd(session, first.request.seq)).toEqual({ ...refused, resetsAt: RESET_AT });
  // Read for the outcome only: the frame is recorded verbatim, with no event of its own.
  expect(session.records().filter((record) => record.kind === "frame" && record.body.type === "rate_limit_event").map((record) => record.kind === "frame" ? record.body : null))
    .toEqual([expect.objectContaining({ events: [] }), { type: "rate_limit_event", native: rejected, events: [] }]);

  // Refused again with nothing changed: claude need not report again, and its last report stands.
  const second = await session.prompt("go on");
  emit(refusedTurn);
  expect(await awaitTurnEnd(session, second.request.seq)).toEqual({ ...refused, resetsAt: RESET_AT });
  await session.dispose();
});

test("no reset unless claude's latest rate_limit_event says the limit refuses requests and names when it resets", () => {
  for (const info of [
    { status: "allowed", resetsAt: RESET, rateLimitType: "five_hour" },
    { status: "allowed_warning", resetsAt: RESET, rateLimitType: "seven_day", utilization: 0.8 },
    // Paid overage takes the requests the plan limit refuses.
    { status: "rejected", resetsAt: RESET, rateLimitType: "five_hour", overageStatus: "allowed", isUsingOverage: true },
    { status: "rejected", rateLimitType: "five_hour" },
    { status: "rejected", resetsAt: "soon" },
  ]) {
    expect(outcomesOf([rateLimitEvent(info), ...refusedTurn]), JSON.stringify(info)).toEqual([refused]);
  }
  // A later event replaces the rejection: the limit no longer refuses.
  expect(outcomesOf([rejected, rateLimitEvent({ status: "allowed", resetsAt: RESET + 18_000, rateLimitType: "five_hour" }), ...refusedTurn])).toEqual([refused]);
  // No rate_limit_event at all (an API key, a throttling 429).
  expect(outcomesOf(refusedTurn)).toEqual([refused]);
});

test("only a failure claude categorizes rate_limit takes the reset", () => {
  expect(outcomesOf([
    rejected,
    { type: "assistant", error: "server_error", message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 529 Overloaded." }] } },
    { type: "result", subtype: "success", is_error: true, api_error_status: 529, terminal_reason: "api_error", result: "API Error: 529 Overloaded." },
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ])).toEqual([{ kind: "failed", reason: "API Error: 529 Overloaded.", failure: "overloaded", status: 529 }, { kind: "completed" }]);
  const limitResetsAt = utcInstantFromDate(new Date(RESET_AT));
  expect(claudeFailure("Credit balance is too low", { category: "billing_error", status: 400, terminalReason: "api_error", limitResetsAt }))
    .toEqual({ kind: "failed", reason: "Credit balance is too low", failure: "billing", status: 400 });
  expect(claudeFailure("Not logged in · Please run /login", { category: "authentication_failed", status: null, terminalReason: "api_error", limitResetsAt }))
    .toEqual({ kind: "failed", reason: "Not logged in · Please run /login", failure: "auth", credential: "missing" });
});
