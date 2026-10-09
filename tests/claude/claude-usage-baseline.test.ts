import { afterEach, expect, test, vi } from "vitest";
import type { RawEvent, Session } from "../../packages/oar/src/index.js";
import { CLAUDE_EFFORT_READBACK_MS } from "../../packages/oar/src/runtimes/claude/effort.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { firstProcess, getUsageAnswer, privateUsageValues, resumedProcess, savedModelUsage } from "../fixtures/claude-usage.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

/*
 * A resume reads its token baseline from claude's own `get_usage` before the
 * first turn (#282): the resumed process continues the previous process's
 * running total. The answer carries account data too, so it is consumed
 * privately like `initialize`. Frames: tests/fixtures/claude-usage.ts.
 */

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "claude" } as const;
afterEach(() => { spawnLineProcess.mockReset(); vi.useRealTimers(); });

const requestOf = (text: string): JsonRecord | null => asRecord(JSON.parse(text));
const subtypeOf = (text: string): unknown => asRecord(requestOf(text)?.request)?.subtype;

/** A claude that answers initialize, and get_usage with `usage` (null: never). */
function scripted(usage: ((id: unknown) => JsonRecord) | null): FakeLineProcess {
  const fake = fakeLineProcess((text, child) => {
    const request = requestOf(text);
    const subtype = subtypeOf(text);
    if (subtype === "initialize") {
      child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: {} } })}\n`);
    } else if (subtype === "get_usage" && usage !== null) {
      child.emit(`${JSON.stringify(usage(request?.request_id))}\n`);
    }
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

/** One prompted turn whose frames are `frames`. */
async function turn(session: Session, fake: FakeLineProcess, frames: readonly JsonRecord[]): Promise<void> {
  await session.prompt("Reply with just: OK");
  for (const frame of frames) { fake.emit(`${JSON.stringify(frame)}\n`); }
}

function lastUsageEvent(session: Session): unknown {
  return session.records().flatMap((record: RawEvent) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "usage") : []).at(-1);
}

/** The open asked initialize, then get_usage, and recorded neither answer, nor a late duplicate. */
function expectPrivateReadbacks(fake: FakeLineProcess, session: Session): void {
  const requests = fake.written.map((text) => requestOf(text));
  expect(requests.map((request) => request?.request)).toEqual([{ subtype: "initialize" }, { subtype: "get_usage", skip_behaviors: true }]);
  fake.emit(`${JSON.stringify(getUsageAnswer(requests[1]?.request_id, savedModelUsage))}\n`);
  expect(session.records()).toEqual([]);
}

test("a resume asks get_usage once, after initialize, privately, and counts from its answer", async () => {
  const fake = scripted((id) => getUsageAnswer(id, savedModelUsage));
  const session = await claudeSession(installation, { cwd: process.cwd(), resume: "4026f386-50ce-46c3-ac8f-7d697183d262" });
  try {
    expectPrivateReadbacks(fake, session);
    await turn(session, fake, resumedProcess);
    expect(session.usage().value).toEqual({ total: { input: 22_087, output: 36, cacheRead: 17_966, cacheWrite: 4111 } });
  } finally { await session.dispose(); }
  const recorded = JSON.stringify(session.records());
  expect(privateUsageValues.filter((value) => recorded.includes(value))).toEqual([]);
});

test("a new session sends no get_usage and counts claude's running total from zero", async () => {
  const fake = scripted(null);
  const session = await claudeSession(installation, { cwd: process.cwd() });
  try {
    expect(fake.written).toEqual([]);
    await turn(session, fake, firstProcess);
    expect(session.usage().value.total).toEqual({ input: 115_697, output: 2213, cacheRead: 92_511, cacheWrite: 21_669 });
  } finally { await session.dispose(); }
});

test("a get_usage refusal leaves the resumed session's total null, its usage events context only", async () => {
  const fake = scripted((id) => ({ type: "control_response", response: { subtype: "error", request_id: id, error: "Unsupported control request subtype: get_usage" } }));
  const session = await claudeSession(installation, { cwd: process.cwd(), resume: "old-id" });
  try {
    await turn(session, fake, resumedProcess);
    expect(session.usage().value).toEqual({ total: null });
    expect(lastUsageEvent(session)).toEqual({ kind: "usage", usage: { context: { tokens: 22_087, contextWindow: 200_000, percent: 11 } } });
    expect(fake.killed()).toBe(false);
  } finally { await session.dispose(); }
});

/** A resume whose get_usage is never answered, opened once the readback bound has passed. */
async function openPastTheBound(fake: FakeLineProcess): Promise<Session> {
  const opening = claudeSession(installation, { cwd: process.cwd(), resume: "old-id" });
  await vi.waitFor(() => { expect(fake.written.map(subtypeOf)).toEqual(["initialize", "get_usage"]); });
  await vi.advanceTimersByTimeAsync(CLAUDE_EFFORT_READBACK_MS);
  return opening;
}

test("an unanswered get_usage opens the resumed session after the readback bound, counting nothing", async () => {
  vi.useFakeTimers();
  const fake = scripted(null);
  const session = await openPastTheBound(fake);
  try {
    expect(fake.killed()).toBe(false);
    await turn(session, fake, resumedProcess);
    expect(session.usage().value).toEqual({ total: null });
  } finally { await session.dispose(); }
});
