import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { runCase } from "../sea-trial/harness/runner.js";
import { sessionCases } from "../sea-trial/cases/session.js";

test("a failed behavior assertion still disposes its opened session", async () => {
  const runtime = scriptedRuntime({ turn: () => {} });
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  const dispose = vi.spyOn(session, "dispose");
  try {
    const result = await runCase({ id: "fails", requires: [], run: async (subject) => {
      await subject.startSession();
      throw new Error("original assertion");
    } }, { id: runtime.id, runtime, startSession: async () => session });
    expect(result).toEqual({ kind: "fail", caseId: "fails", reason: "original assertion" });
    expect(dispose).toHaveBeenCalled();
  } finally { await session.dispose(); }
});

test.each([true, false])("cleanup failure preserves the case failure (%s)", async (fail) => {
  const runtime = scriptedRuntime({ turn: () => {} });
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  const close = session.dispose.bind(session);
  vi.spyOn(session, "dispose").mockRejectedValue(new Error("cleanup failure"));
  try {
    const result = await runCase({ id: "case", requires: [], run: async (instance) => {
      await instance.startSession();
      if (fail) { throw new Error("original assertion"); }
    } }, { id: runtime.id, runtime, startSession: async () => session });
    expect(result).toEqual({ kind: "fail", caseId: "case", reason: fail ? "original assertion" : "cleanup failure" });
  } finally { await close(); }
});

test("a rejected resume retains the original error in the behavior result", async () => {
  const runtime = scriptedRuntime({ turn: () => {} });
  const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  const testCase = sessionCases.find(candidate => candidate.id === "session.resume-or-loud-rejection");
  assert.ok(testCase);
  const result = await runCase(testCase, { id: runtime.id, runtime, startSession: async options => {
    if (options?.resume !== undefined) { throw new Error("native connection closed"); }
    return session;
  } });
  expect(result).toMatchInlineSnapshot(`
    {
      "caseId": "session.resume-or-loud-rejection",
      "kind": "fail",
      "reason": "a runtime without resume must reject loudly, naming resume: Error: native connection closed",
    }
  `);
});
