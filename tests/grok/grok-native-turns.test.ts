import { expect, test } from "vitest";
import { grokNativeTurns } from "../../packages/oar/src/runtimes/grok/native-turns.js";
import { createAcpNativeTurnTracker } from "../../packages/oar/src/shared/acp/native-turns.js";

const queue = (running: string | null, ids: readonly string[] = []) => ({ sessionId: "root", entries: ids.map((id) => ({ id, kind: "prompt" })), ...(running === null ? {} : { runningPromptId: running }) });
const completed = (promptId: string, extra: Record<string, unknown> = {}) => ({ sessionId: "root", update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn", ...extra } });

/** The tracker over a stand-in turn driver: `oar` is an open OAR prompt turn, `adopted` the runtime's own. */
function tracker() {
  const turns = createAcpNativeTurnTracker(grokNativeTurns);
  if (turns === undefined) { throw new Error("grok has native turns"); }
  const driver: { active: object | null; adopted: number; released: number } = { active: null, adopted: 0, released: 0 };
  turns.bind({
    active: () => driver.active,
    adopt: () => { driver.adopted += 1; driver.active = { native: driver.adopted }; return driver.active; },
    release: (turn) => { if (driver.active === turn) { driver.active = null; driver.released += 1; } },
  });
  const project = (method: string, params: Record<string, unknown>, afterOpen = true) => turns.project(method, params, "root", afterOpen);
  return { turns, project, driver };
}

test("Grok's own turn is adopted at its running id and released at its turn_completed, once", () => {
  const { project, driver } = tracker();
  expect(project("_x.ai/queue/changed", queue("subagent-completed-x"))).toEqual([{ kind: "turn_active" }]);
  expect(driver.adopted).toBe(1);
  expect(project("_x.ai/queue/changed", queue("subagent-completed-x"))).toEqual([]);
  expect(project("_x.ai/queue/changed", queue(null))).toEqual([]);
  expect(driver.active).not.toBeNull();
  expect(project("_x.ai/session_notification", completed("subagent-completed-x", { _meta: { eventId: "e1" } }))).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
  expect(driver).toMatchObject({ active: null, released: 1 });
  expect(project("_x.ai/session_notification", completed("subagent-completed-x", { _meta: { eventId: "e1" } }))).toEqual([]);
});

test("two wakes of the same child are two turns, told apart by their native event ids", () => {
  const { project, driver } = tracker();
  for (const eventId of ["root-20", "root-40"]) {
    expect(project("_x.ai/queue/changed", queue("subagent-completed-child"))).toEqual([{ kind: "turn_active" }]);
    project("_x.ai/queue/changed", queue(null));
    expect(project("_x.ai/session_notification", { ...completed("subagent-completed-child"), _meta: { eventId } })).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
  }
  expect(driver).toMatchObject({ adopted: 2, released: 2 });
});

test("an OAR prompt is queued and started with its input id, and its own end report is left to the RPC answer", () => {
  const { turns, project, driver } = tracker();
  const promptId = String(turns.name("input-1").promptId);
  expect(promptId).toMatch(/^oar-/u);
  expect(turns.sentByOar(promptId)).toBe(true);
  expect(project("_x.ai/queue/changed", queue(null, [promptId]))).toEqual([{ kind: "input_queued", inputId: "input-1" }]);
  expect(project("_x.ai/queue/changed", queue(promptId))).toEqual([{ kind: "turn_active", inputId: "input-1" }]);
  expect(driver.adopted).toBe(0);
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
  const { project, driver } = tracker();
  expect(project("_x.ai/session_notification", { ...completed("subagent-completed-old"), _meta: { isReplay: true } })).toEqual([]);
  expect(project("_x.ai/queue/changed", { ...queue("subagent-completed-y"), sessionId: "child" })).toEqual([]);
  expect(project("_x.ai/queue/changed", queue("subagent-completed-z"), false)).toEqual([]);
  expect(driver.adopted).toBe(0);
});

test("a native turn starting inside an open OAR turn is reported once that turn closes, and still runs", () => {
  const { turns, project, driver } = tracker();
  driver.active = { oar: true };
  expect(project("_x.ai/queue/changed", queue("subagent-completed-r"))).toEqual([]);
  driver.active = null;
  expect(turns.afterOarTurn()).toEqual([{ kind: "turn_active" }]);
  expect(driver.adopted).toBe(1);
  expect(project("_x.ai/session_notification", completed("subagent-completed-r"))).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
  expect(driver.active).toBeNull();
});

test("a native run wholly inside an open OAR turn stays inside it", () => {
  const { turns, project, driver } = tracker();
  driver.active = { oar: true };
  expect(project("_x.ai/queue/changed", queue("subagent-completed-s"))).toEqual([]);
  expect(project("_x.ai/session_notification", completed("subagent-completed-s"))).toEqual([]);
  driver.active = null;
  expect(turns.afterOarTurn()).toEqual([]);
  expect(driver.adopted).toBe(0);
});
