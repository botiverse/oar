import { expect, test } from "vitest";
import type { ControlAction, FailureClass, RunningPhase, TaskStatus, TurnOutcome } from "../packages/oar/src/contracts/session.js";
import { failureText, noticeText, noticeTone, phaseLabel, taskStatusLabel, type NoticeTone, type ViewNotice } from "../packages/oar/src/observe/index.js";

const notices = {
  compaction_started: [{ notice: { cause: "compaction_started" }, text: "Compacting context", tone: "quiet" }],
  compaction_ended: [{ notice: { cause: "compaction_ended", outcome: "completed" }, text: "Context compaction completed", tone: "quiet" }],
  retry: [
    { notice: { cause: "retry", attempt: 1 }, text: "Retrying (attempt 1)", tone: "warning" },
    { notice: { cause: "retry", attempt: 2, maxAttempts: 5, delayMs: 1500, reason: "overloaded" }, text: "Retrying (attempt 2 of 5, in 1.5s): overloaded", tone: "warning" },
    { notice: { cause: "retry", attempt: 1, delayMs: 0, reason: "" }, text: "Retrying (attempt 1, in 0s)", tone: "warning" },
  ],
  control_rejected: [{ notice: { cause: "control_rejected", action: "abort", reason: "No active turn" }, text: "Abort rejected: No active turn", tone: "warning" }],
  child_turn_ended: [{ notice: { cause: "child_turn_ended", outcome: { kind: "completed" } }, text: "Subagent turn completed", tone: "quiet" }],
  exited: [
    { notice: { cause: "exited", code: 0 }, text: "Runtime exited (code 0)", tone: "quiet" },
    { notice: { cause: "exited", code: 1 }, text: "Runtime exited (code 1)", tone: "danger" },
    { notice: { cause: "exited", code: null }, text: "Runtime exited", tone: "warning" },
  ],
} satisfies { [Cause in ViewNotice["cause"]]: readonly { notice: Extract<ViewNotice, { cause: Cause }>; text: string; tone: NoticeTone }[] };

test.each(Object.values(notices).flat())("notice $notice has display text and tone", ({ notice, text, tone }) => {
  expect(noticeText(notice)).toBe(text);
  expect(noticeTone(notice)).toBe(tone);
});

const outcomes = {
  completed: { outcome: { kind: "completed" }, text: "Subagent turn completed", tone: "quiet" },
  aborted: { outcome: { kind: "aborted" }, text: "Subagent turn aborted", tone: "warning" },
  failed: { outcome: { kind: "failed", reason: "native failure\nwith details", failure: "provider" }, text: "Subagent turn failed: native failure\nwith details", tone: "danger" },
} satisfies { [Kind in TurnOutcome["kind"]]: { outcome: Extract<TurnOutcome, { kind: Kind }>; text: string; tone: NoticeTone } };

test.each(Object.values(outcomes))("child outcome $outcome.kind is read as an object", ({ outcome, text, tone }) => {
  const notice: ViewNotice = { cause: "child_turn_ended", outcome };
  expect(noticeText(notice)).toBe(text);
  expect(noticeTone(notice)).toBe(tone);
});

const compactions = {
  completed: { text: "Context compaction completed (auto): native detail", tone: "quiet" },
  aborted: { text: "Context compaction aborted (auto): native detail", tone: "warning" },
  failed: { text: "Context compaction failed (auto): native detail", tone: "danger" },
} satisfies Record<Extract<ViewNotice, { cause: "compaction_ended" }>["outcome"], { text: string; tone: NoticeTone }>;

test.each(Object.values(outcomes))("compaction outcome $outcome.kind retains its trigger and reason", ({ outcome }) => {
  const notice: ViewNotice = { cause: "compaction_ended", outcome: outcome.kind, trigger: "auto", reason: "native detail" };
  expect(noticeText(notice)).toBe(compactions[outcome.kind].text);
  expect(noticeTone(notice)).toBe(compactions[outcome.kind].tone);
});

test("optional notice details do not add empty punctuation", () => {
  expect(noticeText({ cause: "compaction_started", trigger: "manual" })).toBe("Compacting context: manual");
  expect(noticeText({ cause: "compaction_started", trigger: "" })).toBe("Compacting context");
  expect(noticeText({ cause: "compaction_ended", outcome: "aborted", trigger: "", reason: "" })).toBe("Context compaction aborted");
});

const actions = {
  prompt: ["prompt", "Prompt rejected: native refusal"], steer: ["steer", "Steer rejected: native refusal"], queue: ["queue", "Queue rejected: native refusal"],
  withdraw: ["withdraw", "Withdraw rejected: native refusal"], abort: ["abort", "Abort rejected: native refusal"], dispose: ["dispose", "Dispose rejected: native refusal"],
} satisfies { [Action in ControlAction]: [Action, string] };

test.each(Object.values(actions))("rejected %s is named", (action, expected) => {
  expect(noticeText({ cause: "control_rejected", action, reason: "native refusal" })).toBe(expected);
});

const phases = {
  waiting_model: ["waiting_model", "Waiting for model"], thinking: ["thinking", "Thinking"],
  responding: ["responding", "Responding"], compacting: ["compacting", "Compacting context"],
} satisfies { [Phase in Extract<RunningPhase, string>]: [Phase, string] };

test.each(Object.values(phases))("phase %s has a label", (phase, label) => {
  expect(phaseLabel(phase)).toBe(label);
});

test("a tool phase keeps the runtime's tool name", () => {
  expect(phaseLabel({ tool: "mcp__server__lookup", callId: "1" })).toBe("Running mcp__server__lookup");
});

test("with a runtime id, a running call reads as its action; MCP and unclassified tools by their short name (#314)", () => {
  expect(phaseLabel({ tool: "Edit", callId: "1" }, "claude")).toBe("Editing file");
  expect(phaseLabel({ tool: "Bash", callId: "1" }, "claude")).toBe("Running command");
  expect(phaseLabel({ tool: "mcp__ferry__show_widget", callId: "1" }, "claude")).toBe("Running show_widget");
  expect(phaseLabel({ tool: "SomethingNew", callId: "1" }, "claude")).toBe("Running SomethingNew");
});

test("a call whose arguments are still streaming reads as writing them (#314)", () => {
  expect(phaseLabel({ tool: "mcp__ferry__show_widget", callId: "1", writing: true }, "claude")).toBe("Writing show_widget arguments");
  expect(phaseLabel({ tool: "mcp__ferry__show_widget", callId: "1", writing: true })).toBe("Writing mcp__ferry__show_widget arguments");
});

const failures = {
  auth: ["auth", "Claude Code could not authenticate."],
  quota: ["quota", "Claude Code reported that its usage limit was reached."],
  rate_limited: ["rate_limited", "Claude Code was rate limited by its provider."],
  billing: ["billing", "Claude Code reported a billing or credit problem."],
  model_unavailable: ["model_unavailable", "Claude Code cannot use the selected model."],
  input_too_large: ["input_too_large", "Claude Code reported that the input is too large for the model."],
  invalid_request: ["invalid_request", "Claude Code rejected the request as invalid."],
  overloaded: ["overloaded", "Claude Code reported that its provider is overloaded."],
  provider: ["provider", "Claude Code reported a provider error."],
  runtime_exited: ["runtime_exited", "Claude Code exited before the turn finished."],
  unknown: ["unknown", "The turn failed."],
} satisfies { [Failure in FailureClass]: [Failure, string] };

test.each(Object.values(failures))("failure %s describes the runtime without host instructions", (failure, text) => {
  expect(failureText(failure, "Claude Code")).toBe(text);
});

test("failure wording uses the caller's runtime name", () => {
  expect(failureText("auth", "Pi")).toBe("Pi could not authenticate.");
});

// A rejected key is not a missing login (oar#227: Raft said "not signed in" for a 401 on an API key).
test("auth wording follows the credential problem the runtime reported", () => {
  expect(failureText("auth", "Pi", "missing")).toBe("Pi is not signed in.");
  expect(failureText("auth", "Pi", "rejected")).toBe("Pi's credentials were rejected.");
});

const statuses = {
  pending: ["pending", "Pending"], running: ["running", "Running"], paused: ["paused", "Paused"],
  completed: ["completed", "Completed"], failed: ["failed", "Failed"], stopped: ["stopped", "Stopped"],
} satisfies { [Status in TaskStatus]: [Status, string] };

test.each(Object.values(statuses))("task status %s has a label", (status, label) => {
  expect(taskStatusLabel(status)).toBe(label);
});
