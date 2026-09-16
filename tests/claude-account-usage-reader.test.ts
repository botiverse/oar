import { afterEach, expect, test, vi } from "vitest";
import { claudeAccountUsage, projectClaudeUsage } from "../packages/oar/src/runtimes/claude/account-usage.js";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "./fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(
  command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv },
) => FakeLineProcess>());
vi.mock("../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "claude" } as const;
const available = {
  subscription_type: "max", rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 25, resets_at: "2026-09-16T12:00:00+08:00" } },
};

afterEach(() => { spawnLineProcess.mockReset(); vi.unstubAllEnvs(); });

function control(text: string): { id: unknown; subtype: unknown } {
  const request = asRecord(parseJson(text));
  return { id: request?.request_id, subtype: asRecord(request?.request)?.subtype };
}

function answer(fake: FakeLineProcess, id: unknown, response: unknown): void {
  fake.emit(`${JSON.stringify({ type: "control_response", response: { request_id: id, subtype: "success", response } })}\n`);
}

function serving(payload: unknown): FakeLineProcess {
  return fakeLineProcess((text, self) => {
    const { id, subtype } = control(text);
    answer(self, id, subtype === "initialize" ? { account: { email: "person@example.com" } } : payload);
  });
}

test("native usage uses correlated control requests, never a prompt or credential subprocess", async () => {
  vi.stubEnv("CLAUDECODE", "nested-session");
  const fake = fakeLineProcess((text, self) => {
    const { id, subtype } = control(text);
    self.emit("not-json\n");
    self.emit(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
    answer(self, "unrelated", { rate_limits_available: false });
    answer(self, id, subtype === "initialize" ? { account: { email: "person@example.com" } } : available);
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeAccountUsage(installation)).resolves.toEqual({
    kind: "available", email: "person@example.com", plan: "max", rateLimited: false,
    windows: [{ label: "Current session", usedRatio: 0.25, resetsAt: "2026-09-16T04:00:00.000Z" }],
  });
  expect(fake.written.map((text) => asRecord(parseJson(text))?.request)).toEqual([
    { subtype: "initialize" }, { subtype: "get_usage", skip_behaviors: true },
  ]);
  expect(spawnLineProcess).toHaveBeenCalledExactlyOnceWith("claude", [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
  ], expect.objectContaining({}));
  expect(spawnLineProcess.mock.calls[0]?.[2].env?.CLAUDECODE).toBeUndefined();
  expect(fake.killed()).toBe(true);
});

test("native unavailable quota is not guessed to mean invalid credentials or auth mode", async () => {
  const fake = serving({ subscription_type: null, rate_limits_available: false, rate_limits: null,
    session: { total_cost_usd: 0, model_usage: {} } });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeAccountUsage(installation)).resolves.toEqual({ kind: "unsupported", reason: "quota_unavailable" });
  expect(fake.killed()).toBe(true);
});

test.each([
  ["Unsupported control request subtype: get_usage", "unsupported", "endpoint_unavailable"],
  ["get_usage is not supported in this context (onGetUsage callback not registered)", "unsupported", "endpoint_unavailable"],
  ["Not logged in. Please run /login", "reauth_required", "not_authenticated"],
])("native rejection: %s", async (nativeError, kind, reason) => {
  const fake = fakeLineProcess((text, self) => {
    const { id, subtype } = control(text);
    if (subtype === "initialize") { answer(self, id, {}); return; }
    self.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: id, error: nativeError } })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeAccountUsage(installation)).resolves.toEqual({ kind, reason });
  expect(fake.killed()).toBe(true);
});

test("operational failures stay errors instead of unsupported or zero usage", async () => {
  const fake = fakeLineProcess((text, self) => {
    const { id, subtype } = control(text);
    if (subtype === "initialize") { answer(self, id, {}); return; }
    self.emit(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: id, error: "upstream unavailable" } })}\n`);
  });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeAccountUsage(installation)).rejects.toThrow("upstream unavailable");
  expect(fake.killed()).toBe(true);
});

test("usage timeout releases the subprocess", async () => {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeAccountUsage(installation, { timeoutMs: 20 })).rejects.toThrow("timed out");
  expect(fake.killed()).toBe(true);
});

test("exit after initialize cannot leave the next query waiting forever", async () => {
  const fake = fakeLineProcess((text, self) => { answer(self, control(text).id, {}); self.end(1); });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeAccountUsage(installation)).rejects.toThrow("exited");
  expect(fake.written).toHaveLength(1);
});

test("exit before an answer fails and releases the subprocess", async () => {
  const fake = fakeLineProcess((_text, self) => { self.end(1); });
  spawnLineProcess.mockReturnValue(fake);
  await expect(claudeAccountUsage(installation)).rejects.toThrow("exited");
  expect(fake.killed()).toBe(true);
});

test("unsupported installation never launches a process", async () => {
  await expect(claudeAccountUsage({ kind: "available", via: "bundled" })).resolves.toEqual({
    kind: "unsupported", reason: "unsupported_installation",
  });
  expect(spawnLineProcess).not.toHaveBeenCalled();
});

test("native windows include model buckets without duplicating legacy model fields", () => {
  expect(projectClaudeUsage({ subscription_type: " max ", rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 7, resets_at: "2026-08-22T09:59:00Z" },
    seven_day: { utilization: 14 },
    seven_day_oauth_apps: { utilization: 3 },
    seven_day_opus: { utilization: 100 },
    model_scoped: [{ display_name: "Fable", utilization: 105, resets_at: "invalid" }],
  } })).toEqual({ kind: "available", plan: "max", rateLimited: true, windows: [
    { label: "Current session", usedRatio: 0.07, resetsAt: "2026-08-22T09:59:00.000Z" },
    { label: "Current week (all models)", usedRatio: 0.14 },
    { label: "Current week (OAuth apps)", usedRatio: 0.03 },
    { label: "Current week (Fable)", usedRatio: 1 },
  ] });
});

test("legacy native model windows and paid headroom remain distinct", () => {
  expect(projectClaudeUsage({ rate_limits_available: true, rate_limits: {
    seven_day_opus: { utilization: 100 }, seven_day_sonnet: { utilization: 0 },
    extra_usage: { is_enabled: true, utilization: 25, monthly_limit: 100, used_credits: 25 },
  } })).toEqual({ kind: "available", rateLimited: false, windows: [
    { label: "Current week (Opus)", usedRatio: 1 },
    { label: "Current week (Sonnet)", usedRatio: 0 },
    { label: "Extra usage", usedRatio: 0.25 },
  ] });
});

test.each([
  {}, { rate_limits_available: "false" }, { rate_limits_available: true, rate_limits: null },
  { rate_limits_available: true, rate_limits: {} },
  { rate_limits_available: true, rate_limits: { five_hour: { utilization: null } } },
  { rate_limits_available: true, rate_limits: { five_hour: { utilization: -1 } } },
  { rate_limits_available: true, rate_limits: { five_hour: { utilization: Number.NaN } } },
])("malformed/unavailable snapshot is never manufactured as zero usage: %j", (payload) => {
  expect(() => projectClaudeUsage(payload)).toThrow();
});
