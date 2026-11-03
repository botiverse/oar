/* oxlint-disable max-statements -- Each checkpoint is tested before and after its native/control boundary. */
import { expect, test } from "vitest";
import { initialStatus, reduceStatus, statusOf, statusValue, type StatusState } from "../packages/oar/src/observe/agent-status.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { initialSessionView, reduceSessionView } from "../packages/oar/src/observe/session-view.js";

const inputId = "11111111-1111-4111-8111-111111111111";
function snapshot(state: StatusState): StatusState {
  // oxlint-disable-next-line typescript/no-unsafe-return, unicorn/prefer-structured-clone -- Exercise the public JSON checkpoint contract.
  return JSON.parse(JSON.stringify(state));
}

test.each(["accepted", "rejected"] as const)("adapter queue stays busy until a carried prompt is %s or withdraw succeeds", async kind => {
  const kernel = createSessionKernel("root");
  await kernel.control({ kind: "queue", input: "held", inputId }, () => ({ kind: "accepted", queued: "adapter" }));
  const records = [...kernel.records()];
  let state = records.reduce((s, r) => reduceStatus(s, r, "root"), initialStatus);
  expect(statusValue(state)).toMatchObject({ kind: "running", phase: "waiting_model" });
  expect(statusValue(state)).not.toHaveProperty("adapterQueue");
  const request = kernel.request("toRuntime", { kind: "prompt", input: "held", carries: [inputId] });
  state = reduceStatus(snapshot(state), request, "root");
  expect(statusValue(state).kind).toBe("running");
  const response = kernel.respond(request.id, kind === "accepted" ? { kind } : { kind, code: "busy", reason: "not yet" });
  state = reduceStatus(snapshot(state), response, "root");
  expect(statusValue(state)).toMatchObject({ kind: "running", phase: "waiting_model" });
  if (kind === "accepted") {
    const end = kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
    state = reduceStatus(snapshot(state), end, "root");
  } else {
    const withdraw = kernel.request("toRuntime", { kind: "withdraw", inputId });
    state = reduceStatus(snapshot(state), withdraw, "root");
    state = reduceStatus(snapshot(state), kernel.respond(withdraw.id, { kind: "accepted" }), "root");
  }
  expect(statusValue(state).kind).toBe("idle");
  expect(statusValue(state)).toEqual(statusOf(kernel.records(), "root").value);
  const checkpoint = records.reduce((s, r) => reduceSessionView(s, r), initialSessionView());
  expect(checkpoint.statusState).toHaveProperty("adapterQueue");
});

test("native-response settlement ignores markers and foreign answers, and survives checkpoint persistence", () => {
  const kernel = createSessionKernel("root");
  const request = kernel.request("toRuntime", { kind: "compact", settledBy: "native_response" });
  let state = reduceStatus(initialStatus, request, "root");
  for (const frame of [
    kernel.frame({ type: "marker", native: {}, events: [{ kind: "compaction_ended", outcome: "completed", requestId: request.id }] }),
    kernel.frame({ type: "answer", native: null, responseTo: "other", events: [] }),
    kernel.frame({ type: "answer", native: null, responseTo: request.id, events: [] }, { sessionId: "foreign" }),
    kernel.frame({ type: "answer", native: null, responseTo: request.id, events: [] }, { agentPath: ["child"] }),
  ]) {
    state = reduceStatus(snapshot(state), frame, "root");
    expect(statusValue(state)).toMatchObject({ kind: "running", phase: "compacting" });
  }
  const answer = kernel.frame({ type: "answer", native: null, responseTo: request.id, events: [] });
  const settled = reduceStatus(snapshot(state), answer, "root");
  expect(statusValue(settled)).toEqual({ kind: "idle" });
});

test("foreign and rejected queue admissions do not invent a held root input", async () => {
  const kernel = createSessionKernel("root");
  await kernel.control({ kind: "queue", input: "child", inputId }, () => ({ kind: "accepted", queued: "adapter" }), { agentPath: ["child"] });
  await kernel.control({ kind: "queue", input: "refused", inputId }, () => ({ kind: "rejected", code: "error", reason: "not taken" }));
  expect(statusOf(kernel.records(), "root").value).toEqual({ kind: "idle" });
});
