import { expect, test } from "vitest";
import { grokNativeTurns } from "../../packages/oar/src/runtimes/grok/native-turns.js";
import { createAcpNativeTurnTracker } from "../../packages/oar/src/shared/acp/native-turns.js";

const queue = (running: string | null, ids: readonly string[] = []) => ({ sessionId: "root", entries: ids.map((id) => ({ id, kind: "prompt" })), ...(running === null ? {} : { runningPromptId: running }) });
const completed = (promptId: string, extra: Record<string, unknown> = {}) => ({ sessionId: "root", update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn", ...extra } });

function tracker() {
  const turns = createAcpNativeTurnTracker(grokNativeTurns);
  if (turns === undefined) { throw new Error("grok has native turns"); }
  const project = (method: string, params: Record<string, unknown>, afterOpen = true) => turns.project(method, params, "root", afterOpen);
  return { turns, project };
}

test("Grok's own turn starts at its running id and ends at its turn_completed, once", () => {
  const { turns, project } = tracker();
  expect(project("_x.ai/queue/changed", queue("subagent-completed-x"))).toEqual([{ kind: "turn_active" }]);
  expect(turns.busy()).toBe(true);
  expect(project("_x.ai/queue/changed", queue("subagent-completed-x"))).toEqual([]);
  expect(project("_x.ai/queue/changed", queue(null))).toEqual([]);
  expect(turns.busy()).toBe(true);
  expect(project("_x.ai/session_notification", completed("subagent-completed-x"))).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
  expect(turns.busy()).toBe(false);
  expect(project("_x.ai/session_notification", completed("subagent-completed-x"))).toEqual([]);
});

test("an OAR prompt is queued and started with its input id, and its own end report is left to the RPC answer", () => {
  const { turns, project } = tracker();
  const meta = turns.name("input-1");
  const promptId = String(meta.promptId);
  expect(promptId).toMatch(/^oar-/u);
  expect(turns.sentByOar(promptId)).toBe(true);
  expect(project("_x.ai/queue/changed", queue(null, [promptId]))).toEqual([{ kind: "input_queued", inputId: "input-1" }]);
  expect(project("_x.ai/queue/changed", queue(promptId))).toEqual([{ kind: "turn_active", inputId: "input-1" }]);
  expect(turns.busy()).toBe(false);
  expect(project("_x.ai/session_notification", completed(promptId))).toEqual([]);
});

test("no prefix is trusted: any name OAR did not give is Grok's", () => {
  const { project } = tracker();
  expect(project("_x.ai/queue/changed", queue("oar-not-ours"))).toEqual([{ kind: "turn_active" }]);
  expect(project("_x.ai/session_notification", completed("oar-not-ours", { stop_reason: "cancelled" }))).toEqual([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
});

test("a failed own turn carries Grok's message and its classified failure", () => {
  const { project } = tracker();
  expect(project("_x.ai/session_notification", completed("interject-fallback-1", { stop_reason: "error", agent_result: "429 Too Many Requests: rate limit exceeded" })))
    .toEqual([{ kind: "turn_ended", outcome: { kind: "failed", reason: "429 Too Many Requests: rate limit exceeded", failure: "rate_limited" } }]);
});

test("history, other sessions and opening frames start or end nothing", () => {
  const { turns, project } = tracker();
  expect(project("_x.ai/session_notification", { ...completed("subagent-completed-old"), _meta: { isReplay: true } })).toEqual([]);
  expect(project("_x.ai/queue/changed", { ...queue("subagent-completed-y"), sessionId: "child" })).toEqual([]);
  expect(project("_x.ai/queue/changed", queue("subagent-completed-z"), false)).toEqual([]);
  expect(turns.busy()).toBe(false);
});

test("while an OAR prompt's turn is open, Grok's next turn is not reported apart", () => {
  const { turns, project } = tracker();
  let open = true;
  turns.bindOarTurn(() => open);
  expect(project("_x.ai/queue/changed", queue("subagent-completed-r"))).toEqual([]);
  expect(turns.busy()).toBe(true);
  open = false;
  // It ends after the OAR turn closed: its end is reported.
  expect(project("_x.ai/session_notification", completed("subagent-completed-r"))).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
  expect(turns.busy()).toBe(false);
});

test("an own turn ending lets held input go", async () => {
  const { turns, project } = tracker();
  let idle = 0;
  turns.onIdle(() => { idle += 1; });
  project("_x.ai/queue/changed", queue("bash-completed-1"));
  project("_x.ai/session_notification", completed("bash-completed-1"));
  await Promise.resolve();
  expect(idle).toBe(1);
});
