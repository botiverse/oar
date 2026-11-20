import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { acpSession } from "../packages/oar/src/shared/acp/session.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { sessionEffortCases } from "../sea-trial/cases/session-effort.js";
import { runCase } from "../sea-trial/harness/runner.js";
import { record } from "../sea-trial/harness/trace.js";

vi.mock("../sea-trial/harness/trace.js", () => ({ record: vi.fn() }));

const start = acpSession({
  args: [fileURLToPath(new URL("fixtures/fake-acp-open-error.mjs", import.meta.url))],
  capabilities: { queue: { durable: false }, attribution: "nested" },
});
const runtime = { ...scriptedRuntime({ turn: () => {} }), listModels: async () => ({ kind: "ok" as const, models: [] }) };

const exitCases = sessionEffortCases.flatMap(trial => [{ trial, method: "initialize", signal: false },
  { trial, method: "session/set_config_option", signal: process.platform !== "win32" }]);

test.each(exitCases)("an early ACP exit during $method remains visible in $trial.id", async ({ trial: testCase, method, signal }) => {
  vi.mocked(record).mockClear();
  const sentinel = "oar-startup-test-value";
  const result = await runCase(testCase, { id: runtime.id, runtime, startSession: async options =>
    start({ kind: "available", via: "executable", command: process.execPath }, {
      cwd: process.cwd(), ...options, env: { FAKE_EXIT_METHOD: method, FAKE_EXIT_BY_SIGNAL: signal ? "1" : "0", TEST_API_KEY: sentinel,
        FAKE_STDERR: `old-prefix${"x".repeat(9000)}\nstartup exited while testing ${String(options?.effort)} with ${sentinel}\n` },
    }) });
  if (result.kind !== "fail") { throw new Error("startup failure passed"); }
  expect(result.reason).toContain(signal ? "signal SIGTERM" : "exit code 1; signal none");
  expect(result.reason).toContain("stderr (tail):\nstartup exited while testing");
  expect(result.reason).toContain("[redacted]");
  expect(result.reason).not.toMatch(/oar-startup-test-value|old-prefix/u);
  expect(record).toHaveBeenCalledWith({ kind: "session_open_failed", caseId: testCase.id, reason: result.reason });
});
