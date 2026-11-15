import { expect, it } from "vitest";
import { factoryOutcome, factoryTokens, foldFactoryNotification, initialFactoryProjection, type FactoryProjection } from "../../packages/oar/src/runtimes/factory/projection.js";
import { projectFactoryUpdateCheck } from "../../packages/oar/src/runtimes/factory/update.js";
import { projectFactoryModels } from "../../packages/oar/src/runtimes/factory/list-models.js";
import { checkFactoryLaunchArgs } from "../../packages/oar/src/runtimes/factory/options.js";
import { serverReply } from "../../packages/oar/src/runtimes/factory/open.js";

const note = (notification: Record<string, unknown>) => ({ jsonrpc: "2.0", type: "notification", method: "droid.session_notification", params: { sessionId: "s", notification } });
function fold(messages: readonly Record<string, unknown>[], start: FactoryProjection = initialFactoryProjection) {
  let state = start;
  const events = messages.flatMap((message) => { const { state: next, body } = foldFactoryNotification(state, message); state = next; return body.events; });
  return { state, events };
}

it("announces a tool call once, then replaces its input as droid streams it, and ends it with droid's result", () => {
  const { events } = fold([
    note({ type: "tool_call", toolUse: { type: "tool_use", id: "c1", name: "Execute", input: {} } }),
    note({ type: "tool_call", toolUse: { type: "tool_use", id: "c1", name: "Execute", input: { command: "ls" } } }),
    note({ type: "tool_result", toolUseId: "c1", content: "a\nb", isError: false }),
  ]);
  expect(events).toEqual([
    { kind: "tool_call_started", callId: "c1", tool: "Execute", input: "{}" },
    { kind: "tool_call_input", callId: "c1", input: "{\"command\":\"ls\"}" },
    { kind: "tool_call_ended", callId: "c1", content: [{ type: "text", text: "a\nb" }], result: "ok" },
  ]);
});

it("echoes only inputs OAR sent, by RPC id and messageId, and drops undrained steering on an interrupt", () => {
  const start: FactoryProjection = { ...initialFactoryProjection, turnId: "in-1",
    sent: new Map([["rpc-1", { requestId: "rpc-1", inputId: "in-1" }], ["rpc-2", { requestId: "rpc-2", inputId: "in-2" }]]) };
  const { events, state } = fold([
    note({ type: "create_message", requestId: "rpc-1", message: { id: "in-1", role: "user", content: [{ type: "text", text: "hello" }] } }),
    note({ type: "create_message", message: { id: "other", role: "user", content: [{ type: "text", text: "internal" }] } }),
    note({ type: "queued_messages_discarded", drainedRequestIds: ["rpc-2"], messages: [{ requestId: "rpc-2", text: "later" }] }),
  ], start);
  expect(events).toEqual([
    { kind: "user_message", input: "hello", inputId: "in-1", nativeMessageId: "in-1", turnId: "in-1", evidence: "turn_item" },
    { kind: "input_dropped", reason: "turn_interrupted", requestId: "rpc-2", inputId: "in-2" },
  ]);
  expect(state.sent.size).toBe(0);
});

it("a prompt droid hands back before starting it is dropped by its RPC id", () => {
  const start: FactoryProjection = { ...initialFactoryProjection, turnId: "in-1", sent: new Map([["rpc-1", { requestId: "rpc-1", inputId: "in-1" }]]) };
  expect(fold([note({ type: "queued_message_handed_back", requestId: "rpc-1", text: "slow" })], start).events)
    .toEqual([{ kind: "input_dropped", reason: "turn_interrupted", requestId: "rpc-1", inputId: "in-1" }]);
});

it("sums turn tokens from open, cache parts inside input, and adds sub-agent tokens to the total only once reported", () => {
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheCreationTokens: 1, thinkingTokens: 0, factoryCredits: 0 };
  const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0 };
  const { events } = fold([
    note({ type: "agent_turn_completed", reason: "completed", turnId: "t1", tokenUsage: usage, childTokenUsage: none }),
    note({ type: "agent_turn_completed", reason: "completed", turnId: "t2", tokenUsage: usage, childTokenUsage: { ...none, inputTokens: 7, outputTokens: 1 } }),
  ]);
  expect(events).toEqual([
    { kind: "usage", usage: { tokens: { input: 16, output: 2, cacheRead: 5, cacheWrite: 1 } } },
    { kind: "turn_ended", outcome: { kind: "completed" }, inputId: "t1" },
    { kind: "usage", usage: { tokens: { input: 32, output: 4, cacheRead: 10, cacheWrite: 2 }, total: { input: 39, output: 5, cacheRead: 10, cacheWrite: 2 } } },
    { kind: "turn_ended", outcome: { kind: "completed" }, inputId: "t2" },
  ]);
  expect(factoryTokens({ inputTokens: 1 })).toBeNull();
});

it("maps droid's turn-end reasons, keeping its last error as the reason", () => {
  expect(factoryOutcome("cancelled", null)).toEqual({ kind: "aborted" });
  expect(factoryOutcome("model_usage_exhausted", "You have used your standard tokens")).toEqual({ kind: "failed", failure: "quota", reason: "You have used your standard tokens" });
  expect(factoryOutcome("model_rate_limited", null)).toMatchObject({ failure: "rate_limited", reason: "Factory droid turn ended: model_rate_limited" });
  expect(factoryOutcome("model_authentication_failed", "No access token available")).toMatchObject({ failure: "auth" });
  const { events } = fold([note({ type: "error", message: "401 Invalid key" }), note({ type: "agent_turn_completed", reason: "model_authentication_failed", turnId: "t" })]);
  expect(events.at(-1)).toEqual({ kind: "turn_ended", outcome: { kind: "failed", failure: "auth", reason: "401 Invalid key" }, inputId: "t" });
});

it("reads model and effort from droid's settings", () => {
  expect(fold([note({ type: "settings_updated", settings: { modelId: "claude-opus-5-5", reasoningEffort: "high" } })]).events)
    .toEqual([{ kind: "model", model: "claude-opus-5-5" }, { kind: "effort", effort: "high" }]);
});

it("reads droid update --check, lists models with their effort menus, and guards launchArgs and droid's requests", () => {
  expect(projectFactoryUpdateCheck("1.12.1", "Droid Update\nCurrent version: 1.12.1\n\nChecking for updates...\n✓ Already up to date!")).toMatchObject({ kind: "ok", latest: "1.12.1", updateAvailable: false });
  expect(projectFactoryUpdateCheck("1.12.1", "Current version: 1.12.1\nUpdate available: 1.13.0\nRun `droid update` without --check to install the update.")).toMatchObject({ kind: "ok", latest: "1.13.0", updateAvailable: true });
  expect(projectFactoryUpdateCheck("1.12.1", "Update error: offline")).toMatchObject({ kind: "unavailable", detail: "Update error: offline" });
  expect(projectFactoryModels({ models: [{ id: "custom:A-0", displayName: "A", supportedReasoningEfforts: ["none"], defaultReasoningEffort: "none" }, { id: "x", disabled: true, disabledReason: "plan" }] }))
    .toEqual([{ id: "custom:A-0", displayName: "A", effortLevels: ["none"], defaultEffort: "none" }, { id: "x", disabled: { reason: "plan" } }]);
  expect(() => { checkFactoryLaunchArgs(["--output-format=json"]); }).toThrow(/launchArgs/u);
  expect(() => { checkFactoryLaunchArgs(["--settings", "x.json"]); }).not.toThrow();
  expect(serverReply("droid.request_permission", { options: [{ value: "proceed_always" }, { value: "proceed_once" }, { value: "cancel" }] })).toEqual({ result: { selectedOption: "proceed_once" } });
  expect(serverReply("droid.ask_user", {})).toEqual({ result: { cancelled: true, answers: [] } });
  expect(serverReply("droid.unknown", {})).toMatchObject({ error: { code: -32_601 } });
});
