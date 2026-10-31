import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { assertCodexHookTrustEvidence, compareCodexHookTrust } from "../experiments/sharing/codex-hook-trust.js";

function evidence(aTrust: boolean): JsonRecord {
  return { observed: true, aBypassHookTrust: aTrust, bBypassHookTrust: !aTrust,
    turns: ["A_mcpbefore", "B_mcpafter", "A_mcpafter"].map((input) => ({
      input, invocation: { isolated: true }, nativeOutputRetained: true,
      directoryRuleMarkers: { initial: false, changed: true },
      hookRevisions: (input.startsWith("A_") ? aTrust : !aTrust) ? [input.slice(0, 1)] : [],
    })) };
}

function setHooks(row: JsonRecord, index: number, hooks: unknown): void {
  assert.ok(Array.isArray(row.turns));
  const turn = asRecord(row.turns[index]); assert.ok(turn);
  turn.hookRevisions = hooks; row.turns[index] = turn;
}

it.each([false, true])("accepts an expected untrusted absence only alongside a positive trusted control (A=%s)", (aTrust) => {
  const row = evidence(aTrust);
  expect(() => { assertCodexHookTrustEvidence(row); }).not.toThrow();
  expect(compareCodexHookTrust(row, evidence(aTrust)).passed).toBe(true);
});

it("rejects trust inherited by an untrusted later B", () => {
  const row = evidence(true); setHooks(row, 1, ["B"]);
  expect(() => { assertCodexHookTrustEvidence(row); }).toThrow("B_mcpafter: hooks must follow this session's own trust parameter");
  expect(compareCodexHookTrust(row, evidence(true)).passed).toBe(false);
});

it.each([false, true])("rejects A changing its trust behavior after B opens (A=%s)", (aTrust) => {
  const row = evidence(aTrust); setHooks(row, 2, aTrust ? [] : ["B"]);
  expect(() => { assertCodexHookTrustEvidence(row); }).toThrow("A_mcpafter: hooks must follow this session's own trust parameter");
  expect(compareCodexHookTrust(row, evidence(aTrust)).passed).toBe(false);
});

it("does not turn missing hooks into denial evidence", () => {
  const row = evidence(false); setHooks(row, 0, undefined);
  expect(compareCodexHookTrust(row, evidence(false)).missingEvidence).toBe(true);
});

it("does not turn an unexecuted tool into denial evidence", () => {
  const unexecuted = evidence(false);
  assert.ok(Array.isArray(unexecuted.turns));
  const first = asRecord(unexecuted.turns[0]); assert.ok(first);
  first.invocation = { isolated: false }; unexecuted.turns[0] = first;
  expect(() => { assertCodexHookTrustEvidence(unexecuted); }).toThrow("actual MCP invocation required");
  expect(compareCodexHookTrust(unexecuted, evidence(false)).passed).toBe(false);
});

it("does not accept a hook that wrote its journal but then failed natively", () => {
  const row = evidence(false); row.nativeHookCompletions = [{ status: "failed", exitCode: 1 }];
  expect(() => { assertCodexHookTrustEvidence(row); }).toThrow("native hook commands must complete successfully");
  expect(compareCodexHookTrust(row, evidence(false)).passed).toBe(false);
});
