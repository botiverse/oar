import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionOptions, RawEvent } from "../../packages/oar/src/index.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "claude" } as const;
// Native 2.1.295 shape from an isolated config home; account identity is synthetic.
const fixture = readFileSync(new URL("../fixtures/claude-initialize-private.json", import.meta.url), "utf8");
const initialized = asRecord(JSON.parse(fixture));
const privateValues = ["oar-private-account@example.test", "oar-private-organization", "oar-private-plan", "oar-private-user", "654321"];
const options: SessionOptions[] = [
  { cwd: "/work", resume: "old-id" },
  { cwd: "/work", serviceTier: "fast" },
  { cwd: "/work", resume: "old-id", serviceTier: "fast", effort: "low" },
];

afterEach(() => { spawnLineProcess.mockReset(); });

function script(fastMode = "on", effort = "low"): FakeLineProcess {
  const fake = fakeLineProcess((text, child) => {
    const request = asRecord(JSON.parse(text));
    const method = asRecord(request?.request)?.subtype;
    const response = method === "initialize" ? { ...initialized, fast_mode_state: fastMode } : { applied: { effort } };
    child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response } })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  return fake;
}

// oxlint-disable-next-line eslint/max-statements -- Keep open, replay, duplicate reply and disposal in one privacy scenario.
test.each(options)("opening keeps account details out of records and replay: %o", async (option) => {
  const fake = script();
  const session = await claudeSession(installation, option);
  const observed: RawEvent[] = [];
  session.rawEvents((record) => { observed.push(record); });
  try {
    // A duplicate answer after opening must remain private, too.
    const request = asRecord(JSON.parse(fake.written[0] ?? "null"));
    fake.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: initialized } })}\n`);
    expect(session.records()).toEqual([]);
    expect(observed).toEqual([]);
    expect(session.serviceTier().value).toBeNull();
  } finally { await session.dispose(); }
  for (const value of privateValues) {
    expect(JSON.stringify(session.records())).not.toContain(value);
    expect(JSON.stringify(observed)).not.toContain(value);
  }
});

test.each([
  { cwd: "/work", serviceTier: "fast" },
  { cwd: "/work", resume: "old-id", serviceTier: "fast" },
  { cwd: "/work", resume: "old-id", effort: "low" },
])("an opening mismatch never exposes private initialization in its error: %o", async (option) => {
  const fake = script("off", "high");
  const failure: unknown = await claudeSession(installation, option).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toHaveProperty("cause");
  for (const value of privateValues) {
    expect(inspect(failure, { depth: null })).not.toContain(value);
    expect(JSON.stringify(failure)).not.toContain(value);
  }
  expect(fake.killed()).toBe(true);
});
