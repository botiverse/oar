import { asRecord } from "../../packages/oar/src/shared/json.js";
/* oxlint-disable eslint/max-statements -- Each control checks native correlation and the shared queue together. */
import { opencodeCompactionEvents } from "../../packages/oar/src/runtimes/opencode/compaction.js";
import { randomUUID } from "node:crypto";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { opencodeAcpProfile, opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-acp-compaction.mjs", import.meta.url));
async function open(backend: "grok" | "opencode", mode: string) {
  const profile = backend === "grok" ? grokAcpProfile : opencodeV2AcpProfile;
  const session = await acpSession({ ...profile,
    promptTokenUsage: (response) => {
      const usage = asRecord(response.usage);
      return typeof usage?.inputTokens === "number" && typeof usage.outputTokens === "number" ? { input: usage.inputTokens, output: usage.outputTokens } : null;
    }, args: [fixture, backend, mode] })({ kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() });
  assert.ok(session.compact !== undefined);
  return { session, compact: session.compact.bind(session) };
}
for (const backend of ["grok", "opencode"] as const) {
  test.each(["completed", "failed", "cancel"] as const)(`${backend} %s uses native evidence and leaves ordinary input reusable`, async (mode) => {
    const f = await open(backend, mode);
    try {
      const pending = f.compact();
      expect(await f.session.prompt("too-early")).toMatchObject({ kind: "rejected", code: "busy" });
      expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
      if (mode === "cancel") { expect(await f.session.abort()).toMatchObject({ kind: "accepted" }); }
      const answer = await pending;
      expect(answer.kind).toBe(mode === "cancel" ? "aborted" : mode);
      assert.ok("frame" in answer);
      expect(answer.frame.agentPath).toEqual([]);
      expect(answer.frame.sessionId).toBe(f.session.id);
      if (backend === "grok") { expect(answer.frame.body.events).toEqual([{ kind: "compaction_ended", outcome: mode === "cancel" ? "aborted" : mode, requestId: answer.request.id }]); }
      else { expect(answer.frame.body.native).toMatchObject({ update: { _meta: { "opencode/compaction": { messageId: "compact-one" } } } }); }
      expect(f.session.status().value.kind).toBe("idle");
      const next = await promptAndWait(f.session, "next"); expect(next.kind).toBe("ended");
    } finally { await f.session.dispose(); }
  });
  test(`${backend} timed out wait retains native ownership and drains held input only after completion`, async () => {
    const f = await open(backend, "hold");
    try {
      expect(await f.compact({ timeoutMs: 5 })).toMatchObject({ kind: "unconfirmed", code: "timeout" });
      const firstId = randomUUID(); const secondId = randomUUID();
      expect(await f.session.queue("first", { inputId: firstId })).toMatchObject({ kind: "accepted" });
      expect(await f.session.queue("withdrawn", { inputId: secondId })).toMatchObject({ kind: "accepted" });
      expect(await f.session.withdraw?.(secondId)).toMatchObject({ kind: "accepted" });
      expect(await f.session.prompt("overtake")).toMatchObject({ kind: "rejected", code: "busy" });
      expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
      expect(f.session.records().some((r) => r.kind === "frame" && r.body.events.some((e) => e.kind === "text_delta"))).toBe(false);
      await f.session.abort();
      await expect.poll(() => f.session.records().flatMap((r) => r.kind === "frame" ? r.body.events.filter(e => e.kind === "text_delta") : [])).toEqual([{ kind: "text_delta", text: "first" }]);
    } finally { await f.session.dispose(); }
  });
  test(`${backend} dispose settles a pending operation without a fabricated native end`, async () => {
    const f = await open(backend, "hold");
    const waiting = f.compact();
    await f.session.dispose();
    expect(await waiting).toMatchObject({ kind: "unconfirmed", code: "disposed" });
  });
}
test("OpenCode v1 omits compact; a v2 response without matching markers remains unconfirmed", async () => {
  const v1 = await acpSession({ ...opencodeAcpProfile, args: [fixture, "opencode", "completed"] })({ kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() });
  expect(v1.compact === undefined).toBe(true); await v1.dispose();
  const f = await open("opencode", "missing");
  try {
    expect(await f.compact()).toMatchObject({ kind: "unconfirmed", code: "observation_failed" });
    expect(f.session.status().value.kind).toBe("idle");
    expect(await f.session.prompt("reusable")).toMatchObject({ kind: "accepted" });
  } finally { await f.session.dispose(); }
});

test.each(["malformed", "disconnect"] as const)("Grok %s does not fabricate a native failed compaction", async (mode) => {
  const f = await open("grok", mode);
  try {
    expect(await f.compact()).toMatchObject({ kind: "unconfirmed", code: mode === "malformed" ? "observation_failed" : "runtime_exited" });
    expect(f.session.records().some(r => r.kind === "frame" && r.body.events.some(e => e.kind === "compaction_ended"))).toBe(false);
    if (mode === "malformed") {
      expect(f.session.status().value.kind).toBe("idle");
      expect(await f.session.prompt("reusable")).toMatchObject({ kind: "accepted" });
    } else { expect(await f.compact()).toMatchObject({ kind: "rejected", code: "runtime_exited" }); }
  } finally { await f.session.dispose(); }
});

test.each(["aborted", "compaction.interrupted"])("OpenCode native %s error projects cancellation without inferring it from text", (type) => {
  expect(opencodeCompactionEvents({ _meta: { "opencode/compaction": { status: "failed", messageId: "native-id", reason: "manual", error: { type, message: "opaque" } } } })).toEqual([{ kind: "compaction_ended", outcome: "aborted", compactionId: "native-id", trigger: "manual" }]);
  expect(opencodeCompactionEvents({ _meta: { "opencode/compaction": { status: "failed", messageId: "native-id", reason: "manual", error: { type: "provider.invalid-request", message: "aborted compaction" } } } })).toEqual([{ kind: "compaction_ended", outcome: "failed", compactionId: "native-id", trigger: "manual" }]);
});

test("OpenCode completed marker does not release queued input before the prompt RPC answers", async () => {
  const f = await open("opencode", "reply-held");
  try {
    const waiting = f.compact({ timeoutMs: 50 });
    await expect.poll(() => f.session.records().some(r => r.kind === "frame" && r.body.events.some(e => e.kind === "compaction_ended" && e.compactionId === "compact-one"))).toBe(true);
    expect(await waiting).toMatchObject({ kind: "unconfirmed", code: "timeout" });
    await f.session.queue("after-rpc");
    expect(await f.session.prompt("overtake")).toMatchObject({ kind: "rejected", code: "busy" });
    expect(f.session.records().some(r => r.kind === "frame" && r.body.events.some(e => e.kind === "text_delta"))).toBe(false);
    await f.session.abort();
    await expect.poll(() => f.session.records().flatMap(r => r.kind === "frame" ? r.body.events.filter(e => e.kind === "text_delta") : [])).toEqual([{ kind: "text_delta", text: "after-rpc" }]);
  } finally { await f.session.dispose(); }
});

for (const backend of ["grok", "opencode"] as const) {
  test.each(["completed", "rpc-error", "missing", "malformed"])(`${backend} %s releases the gate at the correlated response, including synchronous observers`, async (mode) => {
    const f = await open(backend, mode);
    const observed: { kind: string; prompt: ReturnType<typeof f.session.prompt> }[] = [];
    f.session.rawEvents(record => {
      if (record.kind !== "frame" || record.body.responseTo === undefined) { return; }
      observed.push({ kind: f.session.status().value.kind, prompt: f.session.prompt("at-response") });
    });
    try {
      const result = await f.compact();
      if (backend === "opencode" && mode === "rpc-error") {
        expect(result).toMatchObject({ kind: "failed", code: "native_failed", frame: { body: { type: "session/prompt/error", native: { message: "rpc-error" } } } });
      }
      expect(observed).toHaveLength(1); expect(observed[0]?.kind).toBe("idle");
      expect(await observed[0]?.prompt).toMatchObject({ kind: "accepted" });
      expect(result.request.body).toEqual({ kind: "compact", settledBy: "native_response" });
      expect(f.session.records().find(r => r.kind === "frame" && r.body.responseTo !== undefined)).toMatchObject({ body: { responseTo: result.request.id } });
    } finally { await f.session.dispose(); }
  });
}
test.each(["no-method", "no-session", "bad-params"])("Grok %s is a refusal, with no fabricated compaction end", async mode => {
  const f = await open("grok", mode);
  try {
    const result = await f.compact();
    expect(result).toMatchObject({ kind: "rejected", code: "runtime_refused", reason: mode });
    expect(f.session.records().filter(r => r.kind === "response" && r.requestId === result.request.id)).toHaveLength(1);
    expect(f.session.records().some(r => r.kind === "frame" && r.body.events.some(e => e.kind === "compaction_ended"))).toBe(false);
    expect(f.session.status().value.kind).toBe("idle");
  } finally { await f.session.dispose(); }
});
test("OpenCode marker observers still see compacting until the native response, and response usage is retained", async () => {
  const f = await open("opencode", "completed");
  const observed: { status: unknown; prompt: ReturnType<typeof f.session.prompt> }[] = [];
  f.session.rawEvents(record => {
    if (record.kind !== "frame" || !record.body.events.some(e => e.kind === "compaction_ended" && e.compactionId === "compact-one")) { return; }
    observed.push({ status: f.session.status().value, prompt: f.session.prompt("at-marker") });
  });
  try {
    await f.compact();
    expect(observed).toHaveLength(1); expect(observed[0]?.status).toMatchObject({ kind: "running", phase: "compacting" });
    expect(await observed[0]?.prompt).toMatchObject({ kind: "rejected", code: "busy" });
    expect(f.session.records().filter(r => r.kind === "frame" && r.body.responseTo !== undefined)).toMatchObject([{ body: { events: [{ kind: "usage" }] } }]);
    expect(f.session.usage().value).toMatchObject({ total: { input: 12, output: 4 } });
  } finally { await f.session.dispose(); }
});
test.each(["keep", "withdraw"])("ACP held input %s is visibly busy between native completion and dispatch", async mode => {
  const f = await open("grok", "hold");
  const observed: { status: unknown; prompt: ReturnType<typeof f.session.prompt> }[] = [];
  const withdrawal: { pending: ReturnType<NonNullable<typeof f.session.withdraw>> | null } = { pending: null };
  f.session.rawEvents(record => {
    if (record.kind !== "frame" || record.body.responseTo === undefined) { return; }
    observed.push({ status: f.session.status().value, prompt: f.session.prompt("overtake") });
    if (mode === "withdraw") { withdrawal.pending = f.session.withdraw?.("11111111-1111-4111-8111-111111111111") ?? null; }
  });
  try {
    const pending = f.compact();
    await f.session.queue("held", { inputId: "11111111-1111-4111-8111-111111111111" });
    await f.session.abort(); await pending;
    expect(observed[0]?.status).toMatchObject({ kind: "running", phase: "waiting_model" });
    expect(await observed[0]?.prompt).toMatchObject({ kind: "rejected", code: "busy" });
    if (mode === "withdraw") {
      expect(await withdrawal.pending).toMatchObject({ kind: "accepted" });
      expect(f.session.status().value.kind).toBe("idle");
      expect(f.session.records().some(r => r.kind === "request" && r.body.kind === "prompt" && r.body.carries !== undefined)).toBe(false);
    } else {
      await expect.poll(() => f.session.records().some(r => r.kind === "frame" && r.body.events.some(e => e.kind === "text_delta" && e.text === "held"))).toBe(true);
      expect(f.session.records().filter(r => r.kind === "request" && r.body.kind === "prompt" && r.body.carries !== undefined)).toMatchObject([{ body: { input: "held", carries: ["11111111-1111-4111-8111-111111111111"] } }]);
    }
  } finally { await f.session.dispose(); }
});
