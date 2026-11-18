/* oxlint-disable eslint/max-statements -- Ordered protocol interleavings exercise settlement, queued input and lifecycle races. */
import { afterEach, expect, test, vi } from "vitest";
import type { ContextUsage } from "../../packages/oar/src/contracts/session.js";
import { qwenSession } from "../../packages/oar/src/runtimes/qwen/session.js";
import { launchQwen } from "../../packages/oar/src/runtimes/qwen/launch.js";
import { QWEN_CONTEXT_TIMEOUT_MS, qwenContextUsage } from "../../packages/oar/src/runtimes/qwen/context-usage.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

vi.mock("../../packages/oar/src/runtimes/qwen/launch.js", () => ({ launchQwen: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const id = "11111111-1111-4111-8111-111111111111";
const installation = { kind: "available", via: "executable", command: "qwen", version: "0.28.0" } as const;
const data = { subtype: "get_context_usage", totalTokens: 90, contextWindowSize: 300, isEstimated: false };
const answer = (requestId: unknown, body: JsonRecord = data) => ({ type: "control_response", response: { subtype: "success", request_id: requestId, response: body } });
async function open(support = true) {
  const child = fakeLineProcess((text, process) => {
    const frame = asRecord(parseJson(text));
    if (asRecord(frame?.request)?.subtype === "initialize") {
      process.emit(`${JSON.stringify(answer(frame?.request_id, { session_id: id, capabilities: { can_get_context_usage: support } }))}\n`);
    }
  });
  child.stdin.on("finish", () => { child.end(0); });
  vi.mocked(launchQwen).mockResolvedValue(child);
  const session = await qwenSession(installation, { cwd: "/fixture", resume: id });
  const emit = (message: unknown) => { child.emit(`${JSON.stringify(message)}\n`); };
  const contextRequest = () => child.written.map(text => asRecord(parseJson(text))).find(frame => asRecord(frame?.request)?.subtype === "get_context_usage");
  await session.prompt("first");
  emit({ type: "system", subtype: "init", session_id: id });
  return { child, session, emit, contextRequest };
}
const result = { type: "result", subtype: "success", usage: { input_tokens: 5000, output_tokens: 30 } };
const ends = (session: Awaited<ReturnType<typeof qwenSession>>) => session.records().filter(r => r.kind === "frame" && r.agentPath.length === 0 && r.body.events.some(e => e.kind === "turn_ended"));

// Native estimated zero means no last-prompt count; malformed values cannot invent fullness.
test.each([
  [data, { tokens: 90, contextWindow: 300, percent: 30 }],
  [{ ...data, totalTokens: 0, isEstimated: true }, { tokens: null, contextWindow: 300, percent: null }],
  [{ ...data, isEstimated: true }, { tokens: null, contextWindow: 300, percent: null }],
  [{ ...data, totalTokens: -1 }, { tokens: null, contextWindow: 300, percent: null }],
  [{ ...data, contextWindowSize: 0 }, { tokens: 90, contextWindow: null, percent: null }],
  [{ subtype: "get_context_usage" }, null],
  [{ ...data, subtype: "get_usage_info" }, null],
])("projects native context fields %j", (native, expected) => {
  expect(qwenContextUsage(answer("query", native))).toEqual(expected);
});

test("root completion and queued input wait for the correlated context, including on resume", async () => {
  const { child, session, emit, contextRequest } = await open();
  const atEnd: (ContextUsage | null)[] = [];
  session.rawEvents(record => { if (record.kind === "frame" && record.agentPath.length === 0 && record.body.events.some(e => e.kind === "turn_ended")) { atEnd.push(session.contextUsage().value); } });
  try {
    await session.queue("second");
    emit({ ...result, parent_tool_use_id: "child-tool" });
    expect(contextRequest()).toBeUndefined();
    emit(result);
    expect(ends(session)).toHaveLength(0);
    expect(child.written.filter(text => asRecord(parseJson(text))?.type === "user")).toHaveLength(1);
    const aborted = await session.abort();
    expect(aborted.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    const query = contextRequest();
    expect(query?.request).toEqual({ subtype: "get_context_usage", show_details: false });
    emit(answer("unrelated"));
    expect(ends(session)).toHaveLength(0);
    emit(answer(query?.request_id));
    await vi.waitFor(() => { expect(ends(session)).toHaveLength(1); });
    expect(atEnd).toEqual([{ tokens: 90, contextWindow: 300, percent: 30 }]);
    expect(session.usage().value.total).toBeNull();
    expect(child.written.filter(text => asRecord(parseJson(text))?.type === "user")).toHaveLength(2);
    const request = session.records().find(r => r.kind === "request" && r.id === query?.request_id);
    const frame = session.records().find(r => r.kind === "frame" && r.body.responseTo === query?.request_id);
    expect(request?.body).toMatchObject({ kind: "native", type: "get_context_usage", native: query });
    expect(frame?.body).toMatchObject({ native: answer(query?.request_id) });
    expect(frame?.seq).toBeLessThan(ends(session)[0]?.seq ?? 0);
  } finally { await session.dispose(); }
});

test("missing readback times out once, drains input, and preserves a late reply without stale usage", async () => {
  vi.useFakeTimers();
  const { session, emit, contextRequest, child } = await open();
  try {
    await session.queue("next"); emit(result);
    await vi.advanceTimersByTimeAsync(QWEN_CONTEXT_TIMEOUT_MS);
    expect(ends(session)).toHaveLength(1);
    expect(session.contextUsage().value).toBeNull();
    emit(answer(contextRequest()?.request_id));
    expect(session.contextUsage().value).toBeNull();
    expect(child.killed()).toBe(false);
    const responses = session.records().filter(r => r.kind === "response" && r.requestId === contextRequest()?.request_id);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.body).toMatchObject({ kind: "rejected", code: "error" });
    expect(session.records().some(r => r.kind === "frame" && asRecord(asRecord(r.body.native)?.response)?.request_id === contextRequest()?.request_id)).toBe(true);
  } finally { await session.dispose(); }
});

test.each(["exit", "dispose", "refuse"] as const)("%s settles pending context without a deadlock or invented count", async mode => {
  const { session, emit, contextRequest, child } = await open();
  emit(result);
  if (mode === "exit") { child.end(0); }
  if (mode === "dispose") { await session.dispose(); }
  if (mode === "refuse") { emit({ type: "control_response", response: { subtype: "error", request_id: contextRequest()?.request_id, error: "no context" } }); }
  await vi.waitFor(() => { expect(ends(session)).toHaveLength(1); });
  expect(session.contextUsage().value).toBeNull();
  const responses = session.records().filter(r => r.kind === "response" && r.requestId === contextRequest()?.request_id);
  expect(responses).toHaveLength(1);
  if (mode !== "refuse") {
    const exit = session.records().find(r => r.kind === "response" && r.body.kind === "exited");
    expect(exit?.seq).toBeGreaterThan(ends(session)[0]?.seq ?? 0);
    const prompted = await session.prompt("after exit");
    expect(prompted.response.body).toMatchObject({ kind: "rejected" });
  }
  await session.dispose();
});

test("unsupported capability leaves completion synchronous with context absent", async () => {
  const { session, emit, contextRequest } = await open(false);
  try {
    emit(result);
    expect(ends(session)).toHaveLength(1);
    expect(contextRequest()).toBeUndefined();
    expect(session.contextUsage().value).toBeNull();
  } finally { await session.dispose(); }
});

test.each([false, true])("terminal observer sees the readback before admitting its next prompt, held=%s", async held => {
  const { session, emit, contextRequest } = await open();
  const observed: ReturnType<typeof session.prompt>[] = [];
  const tokens: (number | null | undefined)[] = [];
  try {
    if (held) { await session.queue("held"); }
    session.rawEvents(record => {
      if (observed.length === 0 && record.kind === "frame" && record.body.events.some(event => event.kind === "turn_ended")) {
        tokens.push(session.contextUsage().value?.tokens);
        observed.push(session.prompt("from observer"));
      }
    });
    emit(result); emit(answer(contextRequest()?.request_id));
    await vi.waitFor(() => { expect(observed).toHaveLength(1); });
    expect(tokens).toEqual([90]);
    const next = await observed[0];
    expect(next?.response.body).toMatchObject(held ? { kind: "rejected", code: "busy" } : { kind: "accepted" });
  } finally { await session.dispose(); }
});

test("an aborted turn skips readback and keeps the native abort result", async () => {
  const { session, emit, contextRequest, child } = await open();
  try {
    const stopping = session.abort();
    await vi.waitFor(() => { expect(child.written.some(line => asRecord(asRecord(parseJson(line))?.request)?.subtype === "interrupt")).toBe(true); });
    const interrupt = child.written.map(line => asRecord(parseJson(line))).find(frame => asRecord(frame?.request)?.subtype === "interrupt");
    emit(answer(interrupt?.request_id, {}));
    await stopping;
    emit(result);
    expect(contextRequest()).toBeUndefined();
    expect(ends(session)[0]?.body).toMatchObject({ events: [{ kind: "turn_ended", outcome: { kind: "aborted" } }] });
  } finally { await session.dispose(); }
});


test("a request observer can dispose before the context query is written", async () => {
  const { session, emit, contextRequest } = await open();
  const disposing: Promise<void>[] = [];
  session.rawEvents(record => {
    if (record.kind === "request" && record.body.kind === "native" && record.body.type === "get_context_usage") { disposing.push(session.dispose()); }
  });
  emit(result);
  expect(disposing).toHaveLength(1);
  await Promise.all(disposing);
  await vi.waitFor(() => { expect(ends(session)).toHaveLength(1); });
  expect(contextRequest()).toBeUndefined();
  const query = session.records().find(record => record.kind === "request" && record.body.kind === "native" && record.body.type === "get_context_usage");
  const responses = session.records().filter(record => record.kind === "response" && record.requestId === (query?.kind === "request" ? query.id : undefined));
  expect(responses).toHaveLength(1);
  expect(responses[0]?.body).toMatchObject({ kind: "rejected", code: "disposed" });
});
