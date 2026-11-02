/* oxlint-disable eslint/max-statements -- The correlation counterexamples require ordered frames and intermediate assertions. */
import { expect, test, vi } from "vitest";
import { codexCompaction, codexCompactionBusy } from "../../packages/oar/src/runtimes/codex/compaction.js";
import type { AppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { manualCompaction } from "../../packages/oar/src/shared/manual-compaction.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

const request: AppServerClient["request"] = async (_method, _params, settled) => { settled?.({ kind: "result", result: {} }); return {}; };
function setup() {
  const kernel = createSessionKernel("root");
  const call = vi.fn(request);
  const compaction = manualCompaction(kernel, { busy: codexCompactionBusy(kernel, () => false), busyReason: "busy", create: () => codexCompaction({ request: call }, "root") });
  return { kernel, call, ...compaction,
    frame: (type: string, native: Record<string, unknown>, sessionId = "root") => kernel.frame({ type, native: { threadId: sessionId, ...native }, events: [] }, { sessionId }),
  };
}

test("only this root turn and its own started compaction item can complete the request", async () => {
  const f = setup();
  const waiting = f.compact();
  expect(f.call).toHaveBeenCalledWith("thread/compact/start", { threadId: "root" }, expect.any(Function));
  f.frame("turn/started", { turn: { id: "other" } }, "child");
  f.frame("turn/started", { turn: { id: "manual" } });
  f.frame("item/started", { turnId: "manual", item: { type: "contextCompaction", id: "ours" } });
  f.frame("item/completed", { turnId: "other", item: { type: "contextCompaction", id: "ours" } });
  f.frame("item/completed", { turnId: "manual", item: { type: "contextCompaction", id: "foreign" } });
  f.frame("turn/completed", { turn: { id: "other", status: "completed" } });
  expect(f.busy()).toBe(true);
  const boundary = f.frame("item/completed", { turnId: "manual", item: { type: "contextCompaction", id: "ours" } });
  expect(f.busy()).toBe(true);
  f.frame("turn/completed", { turn: { id: "manual", status: "completed" } });
  expect(await waiting).toMatchObject({ kind: "completed", frame: boundary });
});

test.each(["completed", "failed", "interrupted"] as const)("a %s turn without a matching compaction item cannot be successful", async (status) => {
  const f = setup();
  const waiting = f.compact();
  f.frame("turn/started", { turn: { id: "manual" } });
  f.frame("item/completed", { turnId: "manual", item: { type: "contextCompaction", id: "never-started" } });
  f.frame("turn/completed", { turn: { id: "manual", status } });
  expect(await waiting).toMatchObject(status === "interrupted" ? { kind: "aborted" } : { kind: "failed", code: status === "failed" ? "native_failed" : "not_compacted" });
  expect(f.busy()).toBe(false);
});

test("a queued input reserves against compact until its own native echo or refusal", async () => {
  const f = setup();
  const queued = f.kernel.request("toRuntime", { kind: "queue", input: "first", inputId: "input" });
  expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
  f.kernel.respond(queued.id, { kind: "accepted" });
  f.kernel.frame({ type: "item/started", native: {}, events: [{ kind: "user_message", input: "first", evidence: "turn_item", inputId: "input" }] }, { sessionId: "child" });
  expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
  f.kernel.frame({ type: "item/started", native: {}, events: [{ kind: "user_message", input: "first", evidence: "turn_item", inputId: "input" }] });
  const rejected = f.kernel.request("toRuntime", { kind: "queue", input: "second", inputId: "second" });
  f.kernel.respond(rejected.id, { kind: "rejected", code: "runtime_refused", reason: "native refused" });
  const waiting = f.compact();
  expect(f.call).toHaveBeenCalledOnce();
  f.kernel.respond("", { kind: "exited", code: 1 });
  expect(await waiting).toMatchObject({ kind: "unconfirmed", code: "runtime_exited" });
});
