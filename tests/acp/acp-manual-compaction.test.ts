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
  const session = await acpSession({ ...profile, args: [fixture, backend, mode] })({ kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() });
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
    expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
  } finally { await f.session.dispose(); }
});

test.each(["malformed", "disconnect"] as const)("Grok %s does not fabricate a native failed compaction", async (mode) => {
  const f = await open("grok", mode);
  try {
    expect(await f.compact()).toMatchObject({ kind: "unconfirmed", code: mode === "malformed" ? "observation_failed" : "runtime_exited" });
    expect(f.session.records().some(r => r.kind === "frame" && r.body.events.some(e => e.kind === "compaction_ended"))).toBe(false);
    expect(await f.compact()).toMatchObject({ kind: "rejected", code: mode === "malformed" ? "busy" : "runtime_exited" });
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
