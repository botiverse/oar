import { expect, test } from "vitest";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { initialStatus, reduceStatus, statusOf } from "../packages/oar/src/observe/agent-status.js";
import { viewOf } from "../packages/oar/src/observe/session-view.js";

test("native turn_active adopts without a request and repeated observations preserve the phase", () => {
  const kernel = createSessionKernel("conversation");
  const active = kernel.frame({ type: "snapshot", native: { run: {} }, events: [{ kind: "turn_active" }] });
  const adopted = reduceStatus(initialStatus, active);
  expect(adopted).toMatchObject({ kind: "running", phase: "waiting_model", sinceSeq: 0 });
  expect("requestId" in adopted).toBe(false);
  kernel.frame({ type: "tool", native: {}, events: [{ kind: "tool_call_started", callId: "call", tool: "read" }] });
  kernel.frame({ type: "snapshot", native: {}, events: [{ kind: "turn_active" }] });
  expect(statusOf(kernel.records()).value).toMatchObject({ kind: "running", phase: { callId: "call", tool: "read" }, sinceSeq: 0 });
});

test("prompt and native activity share one view turn; foreign activity cannot adopt the root", () => {
  const kernel = createSessionKernel("root");
  kernel.request("toRuntime", { kind: "prompt", input: "hello" });
  kernel.frame({ type: "run_start", native: {}, events: [{ kind: "turn_active" }] });
  expect(viewOf(kernel.records()).messages.filter((message) => message.kind === "turn")).toHaveLength(1);
  const child = createSessionKernel("root");
  const event = child.frame({ type: "run_start", native: {}, events: [{ kind: "turn_active" }] }, { agentPath: ["child"] });
  expect(reduceStatus(initialStatus, event, "root")).toEqual(initialStatus);
});
