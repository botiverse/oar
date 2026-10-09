import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { CLAUDE_EFFORT_READBACK_MS } from "../../packages/oar/src/runtimes/claude/effort.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<() => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "claude" } as const;
const secret = "claude-resume-secret-sentinel";
// Claude 2.1.292 and 2.1.295 report this result before exiting, without an initialize answer.
const fixture = readFileSync(new URL("../fixtures/claude-missing-resume.json", import.meta.url), "utf8");
const missing = asRecord(JSON.parse(fixture));

afterEach(() => { spawnLineProcess.mockReset(); vi.useRealTimers(); });

test("resume rejects at open on the native missing-session result, preserving its redacted cause", async () => {
  const fake = fakeLineProcess((_text, child) => { child.emit(`${JSON.stringify(missing)}\n`); });
  spawnLineProcess.mockReturnValue(fake);
  const opened = await claudeSession(installation, { cwd: process.cwd(), resume: secret, env: { API_KEY: secret } }).catch((error: unknown) => error);
  try {
    expect(opened).toBeInstanceOf(Error);
    expect(opened).toMatchObject({ message: "No conversation found with session ID: [redacted]", cause: { method: "initialize", native: { ...missing, errors: ["No conversation found with session ID: [redacted]"], session_id: "[redacted]" } } });
    expect(inspect(opened, { depth: null })).not.toContain(secret);
    expect(fake.killed()).toBe(true);
  } finally {
    fake.kill();
  }
});


// oxlint-disable-next-line eslint/max-statements -- Keep the pending/unrelated/matched response ordering visible in one scenario.
test("resume does not resolve until its own initialize succeeds, and preserves the native answer", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  let resolved = false;
  const opening = (async () => {
    const session = await claudeSession(installation, { cwd: process.cwd(), resume: "existing-session" });
    resolved = true;
    return session;
  })();
  await vi.waitFor(() => { expect(fake.written).toHaveLength(1); });
  const request = asRecord(JSON.parse(fake.written[0] ?? "null"));
  expect(request?.request).toEqual({ subtype: "initialize" });
  fake.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "unrelated", response: {} } })}\n`);
  await Promise.resolve();
  expect(resolved).toBe(false);
  const answer = { type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: { fast_mode_state: "off" } } };
  fake.emit(`${JSON.stringify(answer)}\n`);
  const session = await opening;
  expect(session.id).toBe("existing-session");
  expect(session.records().some((record) => record.kind === "frame" && JSON.stringify(record.body.native) === JSON.stringify(answer))).toBe(true);
  expect(fake.written).toHaveLength(1);
  await session.dispose();
});

test("a missing-session result arriving before the readback starts still rejects opening", async () => {
  const fake = fakeLineProcess();
  const subscribe = fake.onLine.bind(fake);
  fake.onLine = (handler) => { subscribe(handler); fake.emit(`${JSON.stringify(missing)}\n`); };
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeSession(installation, { cwd: process.cwd(), resume: "missing" })).rejects.toMatchObject({ cause: { method: "initialize", native: missing } });
  expect(fake.written).toEqual([]);
  expect(fake.killed()).toBe(true);
});

test("an exit before initialize without a result names the observed exit, without inventing native data", async () => {
  const fake = fakeLineProcess((_text, child) => { child.end(1); });
  spawnLineProcess.mockReturnValue(fake);
  const failure: unknown = await claudeSession(installation, { cwd: process.cwd(), resume: "missing" }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: "claude exited (code 1) before answering initialize, so resume missing cannot be confirmed" });
  expect(failure).not.toHaveProperty("cause");
});

test("native initialize refusal rejects a resume and retains its error response", async () => {
  const fake = fakeLineProcess((text, child) => {
    const request = asRecord(JSON.parse(text));
    child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: request?.request_id, error: "resume refused" } })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeSession(installation, { cwd: process.cwd(), resume: "old-id" })).rejects.toMatchObject({ cause: { method: "initialize", native: { subtype: "error", error: "resume refused" } } });
  expect(fake.killed()).toBe(true);
});

test("resume initialize has the existing readback deadline and kills an unresponsive process", async () => {
  vi.useFakeTimers();
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const opening = claudeSession(installation, { cwd: process.cwd(), resume: "old-id" });
  const rejected = expect(opening).rejects.toThrow("claude did not answer initialize within 30000 ms, so resume old-id cannot be confirmed");
  await vi.waitFor(() => { expect(fake.written).toHaveLength(1); });
  await vi.advanceTimersByTimeAsync(CLAUDE_EFFORT_READBACK_MS);
  await rejected;
  expect(fake.killed()).toBe(true);
});

test("resume confirms initialize before effort and reuses that answer to confirm service tier", async () => {
  const methods: unknown[] = [];
  const fake = fakeLineProcess((text, child) => {
    const request = asRecord(JSON.parse(text));
    const method = asRecord(request?.request)?.subtype;
    methods.push(method);
    child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: method === "initialize" ? { fast_mode_state: "on" } : { applied: { effort: "low" } } } })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: process.cwd(), resume: "old-id", effort: "low", serviceTier: "fast" });
  expect(methods).toEqual(["initialize", "get_settings"]);
  expect(session.serviceTier().value).toBe("fast");
  await session.dispose();
});

test("a fresh open without readback options sends no initialize", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: process.cwd() });
  expect(fake.written).toEqual([]);
  await session.dispose();
});
