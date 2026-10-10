import { expect, test } from "vitest";
import { usageOf } from "../../packages/oar/src/observe/index.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { createAcpRecorder } from "../../packages/oar/src/shared/acp/records.js";
import { createAcpTokenUsage } from "../../packages/oar/src/shared/acp/token-usage.js";
import { createUsageUpdateGate } from "../../packages/oar/src/shared/acp/usage-wait.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

const method = "_x.ai/session_notification";
function wake(update: JsonRecord = {}): JsonRecord {
  return { sessionId: "root", _meta: { eventId: "root-20" }, update: {
    sessionUpdate: "turn_completed", prompt_id: "subagent-completed-child",
    usage: { inputTokens: 10, outputTokens: 1 }, ...update,
  } };
}

function recording() {
  const kernel = createSessionKernel("root");
  const usage = createAcpTokenUsage(grokAcpProfile);
  const recorder = createAcpRecorder(createUsageUpdateGate(), undefined, usage);
  return { kernel, usage, recorder };
}

test.each([
  { name: "ordinary prompt terminal (already billed by RPC)", params: wake({ prompt_id: "ordinary-prompt" }) },
  { name: "incomplete wake id", params: wake({ prompt_id: "subagent-completed-" }) },
  { name: "response instead of terminal", params: wake({ sessionUpdate: "response_completed" }) },
  { name: "input-only ledger", params: wake({ usage: { inputTokens: 10 } }) },
  { name: "output-only ledger", params: wake({ usage: { outputTokens: 1 } }) },
  { name: "no ledger", params: wake({ usage: null }) },
  { name: "no native report identity", params: { ...wake(), _meta: {} } },
  { name: "empty native report identity", params: { ...wake(), _meta: { eventId: "" } } },
  { name: "child wake", params: { ...wake(), sessionId: "child" } },
  { name: "unknown owner", params: { ...wake(), sessionId: null } },
  { name: "different vendor method", params: wake(), method: "_x.ai/queue/changed" },
])("$name stays native-only", ({ params, method: source = method }) => {
  const { kernel, recorder } = recording();
  recorder.bind(kernel);
  recorder.extension(source, params);
  expect(kernel.records()).toHaveLength(1);
  expect(kernel.records()[0]).toMatchObject({ body: { native: params, events: [] } });
  expect(usageOf(kernel.records(), "root").value).toEqual({ total: null });
});

// oxlint-disable-next-line eslint/max-statements -- A pre-bind duplicate, a child and later RPC all share one accounting boundary.
test("queued root wake bills once; child cannot consume its identity; later RPC retains it", () => {
  const { kernel, recorder, usage } = recording();
  recorder.extension(method, { ...wake(), sessionId: "child" });
  recorder.extension(method, wake());
  recorder.extension(method, wake());
  recorder.bind(kernel);
  recorder.extension(method, wake());
  expect(usageOf(kernel.records(), "root").value).toEqual({ total: { input: 10, output: 1 } });
  const event = usage.prompt({ _meta: { usage: { inputTokens: 100, outputTokens: 2, cachedReadTokens: 30, cacheCreationTokens: 0 } } });
  kernel.frame({ type: "session/prompt", native: null, events: event === null ? [] : [event] });
  expect(usageOf(kernel.records(), "root").value).toEqual({ total: { input: 110, output: 3, cacheRead: 30, cacheWrite: 0 } });
  expect(kernel.records()).toHaveLength(5);
});

test("a new native report for a reused wake prompt id is a new bill, including cache parts", () => {
  const { kernel, recorder } = recording();
  recorder.bind(kernel);
  recorder.extension(method, wake());
  recorder.extension(method, { ...wake({ usage: { inputTokens: 20, outputTokens: 2, cachedReadTokens: 8, cacheCreationTokens: 4 } }), _meta: { eventId: "root-40" } });
  expect(usageOf(kernel.records(), "root").value).toEqual({ total: { input: 30, output: 3, cacheRead: 8, cacheWrite: 4 } });
});

test("a zero ledger is a report, and duplicate tracking is scoped to the opened session", () => {
  for (const { kernel, recorder } of [recording(), recording()]) {
    recorder.bind(kernel);
    recorder.extension(method, wake({ usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 } }));
    expect(usageOf(kernel.records(), "root").value).toEqual({ total: { input: 0, output: 0, cacheRead: 0 } });
  }
});
