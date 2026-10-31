import { afterEach, expect, test, vi } from "vitest";
import { openCodeDiagnosticSummary } from "../../packages/oar/src/runtimes/opencode/sharing-diagnostics.js";

afterEach(() => { vi.useRealTimers(); });

// eslint-disable-next-line max-statements -- Keep one interval's before/after checks together.
test("continuous late frames produce bounded count-only summaries without retaining payloads", () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const report = vi.fn<(summary: unknown) => void>(); const diagnostic = openCodeDiagnosticSummary(report);
  const frame = { method: "session/update", params: { text: "private body" }, receivedAt: 0, reason: "retired" } as const;
  for (let i = 0; i < 10_000; i++) { diagnostic(frame); }
  expect(report).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(29_999);
  diagnostic({ ...frame, reason: "conflict" });
  expect(report).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(report.mock.calls).toEqual([
    [{ kind: "connection_diagnostics", frames: 1, reasons: { retired: 1 } }],
    [{ kind: "connection_diagnostics", frames: 10_000, reasons: { retired: 9999, conflict: 1 } }],
  ]);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(60_000);
  expect(report).toHaveBeenCalledTimes(2);
});

test("a failed summary observer cannot throw from the later timer", () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const diagnostic = openCodeDiagnosticSummary(() => { throw new Error("observer failed"); });
  const entry = { method: "unknown", params: null, receivedAt: 0, reason: "unowned" } as const;
  expect(() => { diagnostic(entry); diagnostic(entry); vi.advanceTimersByTime(30_000); }).not.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});
