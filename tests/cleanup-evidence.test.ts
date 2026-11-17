import { expect, test, vi } from "vitest";
import type { ProcessCleanupDiagnostics, Observation } from "../packages/oar/src/shared/executable/process-cleanup-diagnostics.js";
import { expectCleanupEvidence } from "./fixtures/cleanup-evidence.js";

const timeout: Observation = { ok: false, phase: "before_cancel", source: "windows", reason: "timeout", timeoutMs: 1000, elapsedMs: 1027 };
const { timeoutMs: _budget, ...withoutBudget } = timeout;
const reason = "Descendant cleanup could not be verified: before_cancel windows: timeout (1027 ms)";
const evidence: ProcessCleanupDiagnostics = { status: "unverified", observations: [timeout] };

test("accepts the recorded Windows timeout while retaining its unverified exit", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expectCleanupEvidence(evidence, reason, { platform: "win32" });
    expect(log).toHaveBeenCalledWith("OAR_CLEANUP_EVIDENCE", JSON.stringify({ evidence, reason }));
  } finally { log.mockRestore(); }
});

test.each([
  ["missing evidence", undefined, reason],
  ["empty observations", { status: "unverified", observations: [] }, reason],
  ["false observed claim", { ...evidence, status: "observed" }, undefined],
  ["missing warning", evidence, undefined],
  ["unrelated warning", evidence, "native error"],
  ["warning from another phase", evidence, reason.replace("before_cancel", "after_exit")],
  ["unexplained unverified", { status: "unverified", observations: [{ ok: true, phase: "before_cancel", source: "windows", elapsedMs: 1, skipped: 0 }] }, reason],
  ["command failure", { ...evidence, observations: [{ ...timeout, reason: "command_failed" }] }, reason],
  ["missing root", { ...evidence, observations: [{ ...timeout, reason: "missing_root" }] }, reason],
  ["other source", { ...evidence, observations: [{ ...timeout, source: "ps" }] }, reason],
  ["larger product budget", { ...evidence, observations: [{ ...timeout, timeoutMs: 2000 }] }, reason],
  ["missing budget", { ...evidence, observations: [withoutBudget] }, reason],
  ["not expired", { ...evidence, observations: [{ ...timeout, elapsedMs: 1 }] }, reason],
] satisfies readonly [string, ProcessCleanupDiagnostics | undefined, string | undefined][])("rejects %s", (_name, recorded, exitReason) => {
  expect(() => { expectCleanupEvidence(recorded, exitReason, { platform: "win32" }); }).toThrow();
});

test("a timeout elsewhere cannot excuse a command failure or a POSIX failure", () => {
  expect(() => { expectCleanupEvidence({ ...evidence, observations: [timeout, { ...timeout, phase: "after_exit", reason: "command_failed" }] }, reason, { platform: "win32" }); }).toThrow();
  expect(() => { expectCleanupEvidence(evidence, reason, { platform: "linux" }); }).toThrow();
});

test("successful capture still requires observed status and no cleanup warning", () => {
  const captured: ProcessCleanupDiagnostics = { status: "observed", observations: [{ ok: true, phase: "before_cancel", source: "windows", elapsedMs: 12, skipped: 0 }] };
  expectCleanupEvidence(captured, undefined, { platform: "win32" });
  expect(() => { expectCleanupEvidence(captured, reason, { platform: "win32" }); }).toThrow();
});

test("pre-EOF retry uses only the remaining capture budget", () => {
  const retry: ProcessCleanupDiagnostics = { status: "unverified", observations: [{ ...timeout, phase: "before_eof", timeoutMs: 4000, elapsedMs: 4001 }] };
  expectCleanupEvidence(retry, "Descendant cleanup could not be verified: before_eof windows: timeout (4001 ms)", { platform: "win32" });
});
