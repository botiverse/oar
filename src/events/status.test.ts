import assert from "node:assert/strict";
import test from "node:test";
import { Diagnostic } from "./diagnostic.js";
import type { RuntimeEvent } from "./event.js";
import {
  foldTurnStatus,
  stepTurnStatus,
  isRetriableError,
  isKnownEventKind,
  type TurnStatus,
} from "./status.js";

const err = (cls: Parameters<typeof Diagnostic.fromRaw>[0]): RuntimeEvent => ({
  kind: "runtime_error",
  detail: Diagnostic.fromRaw(cls, "detail"),
});

// --- the fold: event prefix → status ---

test("empty stream is idle", () => {
  assert.equal(foldTurnStatus([]), "idle");
});

test("a normal turn: text → tool → result → completed folds idle", () => {
  const events: RuntimeEvent[] = [
    { kind: "text", text: "thinking..." },
    { kind: "tool_call", callId: "c1", name: "bash" },
    { kind: "tool_result", callId: "c1", ok: true },
    { kind: "turn_end", reason: "completed" },
  ];
  assert.equal(foldTurnStatus(events), "idle");
});

test("an open tool_call folds tool-executing", () => {
  assert.equal(
    foldTurnStatus([
      { kind: "text", text: "x" },
      { kind: "tool_call", callId: "c1", name: "bash" },
    ]),
    "tool-executing",
  );
});

test("turn_end{crashed} folds crashed", () => {
  assert.equal(foldTurnStatus([{ kind: "turn_end", reason: "crashed" }]), "crashed");
});

test("turn_end{interrupted} folds idle, not crashed", () => {
  assert.equal(foldTurnStatus([{ kind: "turn_end", reason: "interrupted" }]), "idle");
});

// --- #840: retriable error must NOT fold to terminal ---

test("#840: a capacity error folds recovering, NOT crashed", () => {
  assert.equal(foldTurnStatus([err("capacity")]), "recovering");
});

test("#840: a genuinely terminal error folds crashed", () => {
  assert.equal(foldTurnStatus([err("crashed")]), "crashed");
  assert.equal(foldTurnStatus([err("launch_failed")]), "crashed");
  assert.equal(foldTurnStatus([err("credential_missing")]), "crashed");
});

test("#840: recovering is not sticky — the process resumes on next output", () => {
  assert.equal(foldTurnStatus([err("capacity"), { kind: "text", text: "back" }]), "thinking");
});

test("crashed is absorbing — later noise does not un-crash", () => {
  assert.equal(
    foldTurnStatus([err("crashed"), { kind: "text", text: "noise" }]),
    "crashed",
  );
});

// --- classification is exhaustive and conservative ---

test("isRetriableError: only transient classes are retriable", () => {
  assert.equal(isRetriableError(Diagnostic.fromRaw("capacity", "x")), true);
  assert.equal(isRetriableError(Diagnostic.fromRaw("stalled", "x")), true);
  assert.equal(isRetriableError(Diagnostic.fromRaw("crashed", "x")), false);
  assert.equal(isRetriableError(Diagnostic.fromRaw("launch_failed", "x")), false);
  assert.equal(isRetriableError(Diagnostic.fromRaw("credential_missing", "x")), false);
  assert.equal(isRetriableError(Diagnostic.fromRaw("protocol_violation", "x")), false);
  // unknown is conservatively NON-retriable: do not resurrect on an unclassified failure.
  assert.equal(isRetriableError(Diagnostic.fromRaw("unknown", "x")), false);
});

// --- wire firewall guard ---

test("isKnownEventKind guards the cross-version fault line", () => {
  for (const k of ["text", "tool_call", "tool_result", "turn_end", "runtime_error"]) {
    assert.equal(isKnownEventKind(k), true);
  }
  assert.equal(isKnownEventKind("some_future_kind"), false);
  assert.equal(isKnownEventKind(undefined), false);
  assert.equal(isKnownEventKind(42), false);
});

test("stepTurnStatus step semantics", () => {
  const cases: [TurnStatus, RuntimeEvent, TurnStatus][] = [
    ["idle", { kind: "text", text: "x" }, "thinking"],
    ["thinking", { kind: "tool_call", callId: "c", name: "n" }, "tool-executing"],
    ["tool-executing", { kind: "tool_result", callId: "c", ok: false }, "thinking"],
  ];
  for (const [prev, event, want] of cases) {
    assert.equal(stepTurnStatus(prev, event), want);
  }
});
