import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { foldPiEvent, initialPiProjection, type PiFoldExtra } from "../../packages/oar/src/runtimes/pi/projection.js";
import { EXTENSION_PLAN_DETAILS_KEY, EXTENSION_PLAN_PROTOCOL } from "../../packages/oar/src/shared/extension-plan.js";
import { piReportedTools, type PiLoadedTool } from "../../packages/oar/src/runtimes/pi/tools.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

/**
 * Pi registers no checklist tool and tracks no plan of its own. A checklist
 * therefore comes from an EXTENSION, and OAR reads it from the tool's
 * STRUCTURED RESULT — not from the requested arguments — and only when that
 * same opened session reported the tool's loaded identity. A claim is never
 * inferred from a tool name, a runtime version or a file on disk: no report
 * means no extension, and a failed call means no checklist.
 */
const EXTENSION_TOOL = "Checklist";
const STEPS = [{ step: "a", status: "pending" }];

function loaded(name: string, source: string, path = `/home/agent/extensions/${source}.ts`): PiLoadedTool {
  return { name, path, source };
}

function started(toolName: string, args: unknown): AgentSessionEvent {
  return { type: "tool_execution_start", toolCallId: `call_${toolName}`, toolName, args };
}

function ended(toolName: string, details: unknown, isError = false): AgentSessionEvent {
  return { type: "tool_execution_end", toolCallId: `call_${toolName}`, toolName, isError, result: { content: [{ type: "text", text: "ok" }], details } };
}

function report(steps: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { [EXTENSION_PLAN_DETAILS_KEY]: { protocol: EXTENSION_PLAN_PROTOCOL, steps, ...extra } };
}

function events(event: AgentSessionEvent, extra: PiFoldExtra = {}): readonly unknown[] {
  const { commands } = foldPiEvent(initialPiProjection, event, extra);
  return commands[0]?.body.events ?? [];
}

function kinds(list: readonly unknown[]): readonly string[] {
  return list.map((event) => {
    const record = asRecord(event);
    return typeof record?.kind === "string" ? record.kind : "?";
  });
}

/** The verified source an event carries, when it carries one. */
function sourceOf(event: unknown): string | undefined {
  const extension = asRecord(asRecord(event)?.extension);
  return typeof extension?.source === "string" ? extension.source : undefined;
}

/** What one call's result produces in a session that reported `tools` (absent: no report at all). */
function resultKinds(details: unknown, tools?: readonly PiLoadedTool[], isError = false): readonly string[] {
  return kinds(events(ended(EXTENSION_TOOL, details, isError), tools === undefined ? {} : { loadedTools: tools }));
}

test("a successful, versioned result from a tool this session reported as an extension is one whole-list plan", () => {
  const details = report(
    [{ step: "Read the contract", status: "in_progress" }, { step: "Wire the result", status: "pending", priority: "high" }],
    { explanation: "Two steps" },
  );
  const observed = events(ended(EXTENSION_TOOL, details), { loadedTools: [loaded(EXTENSION_TOOL, "team-checklist")] });
  assert.deepEqual(observed, [
    { kind: "tool_call_ended", callId: "call_Checklist", content: [{ type: "text", text: "ok" }], result: "ok" },
    {
      kind: "plan_changed",
      channel: "extension",
      evidence: "tool_call",
      callId: "call_Checklist",
      plan: { steps: [{ step: "Read the contract", status: "in_progress" }, { step: "Wire the result", status: "pending", priority: "high" }], explanation: "Two steps" },
      extension: { tool: EXTENSION_TOOL, source: "team-checklist", protocol: EXTENSION_PLAN_PROTOCOL },
    },
  ]);
});

test("an empty list is the extension's own clear, reported with its verified identity", () => {
  const observed = events(ended(EXTENSION_TOOL, report([])), { loadedTools: [loaded(EXTENSION_TOOL, "team-checklist")] });
  assert.deepEqual(observed.at(1), {
    kind: "plan_changed",
    channel: "extension",
    evidence: "tool_call",
    callId: "call_Checklist",
    plan: { steps: [] },
    extension: { tool: EXTENSION_TOOL, source: "team-checklist", protocol: EXTENSION_PLAN_PROTOCOL },
  });
});

test("the requested arguments are never a checklist: only a result reports one", () => {
  // The call itself carries a plausible list; without a result it is a call and nothing more.
  const call = started(EXTENSION_TOOL, { todos: STEPS });
  const observed = events(call, { loadedTools: [loaded(EXTENSION_TOOL, "team-checklist")] });
  assert.deepEqual(kinds(observed), ["tool_call_started"]);
});

test("a session that reported no tool list makes no extension claim", () => {
  assert.deepEqual(resultKinds(report(STEPS)), ["tool_call_ended"]);
  assert.deepEqual(resultKinds(report(STEPS), []), ["tool_call_ended"]);
});

test("a different plugin, or an unknown one, is not the extension that reported", () => {
  // The session reported a checklist tool from another source: nothing verifies this one.
  assert.deepEqual(resultKinds(report(STEPS), [loaded("Other", "other-plugin")]), ["tool_call_ended"]);
  // Pi's own builtin of that name is the runtime's tool, not an extension.
  const builtin = [loaded(EXTENSION_TOOL, "builtin", `builtin:${EXTENSION_TOOL}`)];
  assert.deepEqual(resultKinds(report(STEPS), builtin), ["tool_call_ended"]);
  // Two sources for one name is not a verified identity either.
  const twice = [loaded(EXTENSION_TOOL, "one"), loaded(EXTENSION_TOOL, "two")];
  assert.deepEqual(resultKinds(report(STEPS), twice), ["tool_call_ended"]);
});

test("a failed call reports no checklist, whatever its result says", () => {
  const observed = events(ended(EXTENSION_TOOL, report(STEPS), true), { loadedTools: [loaded(EXTENSION_TOOL, "team-checklist")] });
  assert.deepEqual(kinds(observed), ["tool_call_ended"]);
  assert.deepEqual(observed[0], { kind: "tool_call_ended", callId: "call_Checklist", content: [{ type: "text", text: "ok" }], result: "failed" });
});

test("an unreadable result or a protocol this OAR does not read reports nothing", () => {
  const verified = [loaded(EXTENSION_TOOL, "team-checklist")];
  const unreadable: readonly unknown[] = [
    undefined,
    { other: true },
    { [EXTENSION_PLAN_DETAILS_KEY]: { protocol: EXTENSION_PLAN_PROTOCOL } },
    { [EXTENSION_PLAN_DETAILS_KEY]: { protocol: 2, steps: STEPS } },
    { [EXTENSION_PLAN_DETAILS_KEY]: { protocol: "1", steps: STEPS } },
    report([{ step: "a" }]),
    report([null]),
  ];
  for (const details of unreadable) {
    assert.deepEqual(resultKinds(details, verified), ["tool_call_ended"]);
  }
});

test("two sessions in one process keep their own reports", () => {
  const event = ended(EXTENSION_TOOL, report(STEPS));
  const first = events(event, { loadedTools: [loaded(EXTENSION_TOOL, "checklist-one")] });
  const second = events(event, { loadedTools: [loaded(EXTENSION_TOOL, "checklist-two")] });
  const third = events(event, { loadedTools: [loaded("Unrelated", "checklist-one")] });
  assert.equal(sourceOf(first[1]), "checklist-one");
  assert.equal(sourceOf(second[1]), "checklist-two");
  assert.deepEqual(kinds(third), ["tool_call_ended"]);
});

test("the child's report is read only in the documented shape", () => {
  assert.deepEqual(piReportedTools({ type: "tools", tools: [{ name: "Checklist", path: "/x/checklist.ts", source: "checklist" }] }), [
    { name: "Checklist", path: "/x/checklist.ts", source: "checklist" },
  ]);
  assert.deepEqual(piReportedTools({ type: "tools", tools: [{ name: "half" }] }), []);
  assert.deepEqual(piReportedTools({ type: "tools" }), []);
  assert.deepEqual(piReportedTools("tools"), []);
});
