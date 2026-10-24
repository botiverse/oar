import { afterEach, expect, test, vi } from "vitest";
import { qoderSession } from "../../packages/oar/src/runtimes/qoder/session.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const launch = vi.hoisted(() => ({ launchQoder: vi.fn(), closeQoder: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/qoder/launch.js", () => launch);
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

const privateData = { email: "private@example.invalid", username: "private-user", org_id: "private-org", access_token: "fixture-private-token" };
function privateControlProcess() {
  const child = fakeLineProcess((line, process) => {
    const request = asRecord(parseJson(line));
    if (asRecord(request?.request)?.subtype === "initialize") {
      process.emit(`${JSON.stringify({ type: "system", subtype: "init", model: "efficient" })}\n`);
    }
    const payload = asRecord(request?.request)?.subtype === "get_settings"
      ? { sources: { user: privateData }, effective: privateData, applied: { effort: "high", ...privateData } } : privateData;
    process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: payload } })}\n`);
  });
  launch.launchQoder.mockResolvedValue(child);
  launch.closeQoder.mockImplementation(async () => { child.end(0); await child.exited; });
  return child;
}
function expectPrivateDataAbsent(records: string) {
  for (const value of Object.values(privateData)) { expect(records).not.toContain(value); }
  expect(records).not.toContain('"email"');
  expect(records).not.toContain('"org_id"');
}

test("private initialize and settings, including repeated responses, never expose account or configuration", async () => {
  const child = privateControlProcess();
  const session = await qoderSession({ kind: "available", via: "executable", command: "fixture", version: "1.1.78" }, { cwd: "/work", model: "efficient", effort: "high" });
  try {
    const initialize = asRecord(parseJson(child.written[0] ?? ""));
    child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: initialize?.request_id, response: privateData } })}\n`);
    expect(session.effort().value).toBe("high");
    expectPrivateDataAbsent(JSON.stringify(session.records()));
    expect(session.status().value.kind).toBe("idle");
  } finally { await session.dispose(); }
});

function slowControlProcess(initializeMs: number | null, settingsMs: number | null = 0) {
  const child = fakeLineProcess((line, process) => {
    const request = asRecord(parseJson(line));
    const subtype = asRecord(request?.request)?.subtype;
    const delay = subtype === "initialize" ? initializeMs : settingsMs;
    if (delay === null) { return; }
    setTimeout(() => {
      if (subtype === "initialize") { process.emit(`${JSON.stringify({ type: "system", subtype: "init", model: "efficient" })}\n`); }
      process.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request?.request_id, response: {} } })}\n`);
    }, delay);
  });
  launch.launchQoder.mockResolvedValue(child);
  launch.closeQoder.mockImplementation(async () => { child.end(0); await child.exited; });
  return child;
}
async function openSlowProcess() {
  const session = await qoderSession({ kind: "available", via: "executable", command: "fixture", version: "1.1.78" }, { cwd: "/work" });
  return session;
}

test("a slow native initialize can finish after the former 30-second deadline", async () => {
  vi.useFakeTimers();
  slowControlProcess(45_000);
  const opening = openSlowProcess();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(launch.closeQoder).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15_001);
  const session = await opening;
  try { expect(session.status().value.kind).toBe("idle"); }
  finally { await session.dispose(); }
});

test("a silent initialize still fails and closes its process after 60 seconds", async () => {
  vi.useFakeTimers();
  const child = slowControlProcess(null);
  const rejected = expect(openSlowProcess()).rejects.toThrow("initialize within 60000 ms");
  await vi.advanceTimersByTimeAsync(59_999);
  expect(launch.closeQoder).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(launch.closeQoder).toHaveBeenCalledWith(child);
  expect(await child.exited).toBe(0);
});

test("the longer initialize budget does not extend later controls", async () => {
  vi.useFakeTimers();
  const child = slowControlProcess(1, null);
  const rejected = expect(openSlowProcess()).rejects.toThrow("get_settings within 30000 ms");
  await vi.advanceTimersByTimeAsync(30_001);
  await rejected;
  expect(launch.closeQoder).toHaveBeenCalledWith(child);
});
