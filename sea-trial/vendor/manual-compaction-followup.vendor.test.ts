/* oxlint-disable eslint/max-statements -- Native controls keep lifecycle and evidence assertions together. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, onTestFailed, test, vi } from "vitest";
import type { LLMock } from "@copilotkit/aimock";
import { grokRuntime, opencodeRuntime, qoderRuntime, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { startGrokAimock, startOpencodeAimock } from "../harness/aimock-acp.js";
import { opencodeMajor } from "../../packages/oar/src/runtimes/opencode/version.js";
import { startQoderNative } from "../harness/qoder-native.js";

const backend = process.env.OAR_TEST;
const qoder = backend === "qoder-native";
const opencode = backend === "opencode-aimock" ? await opencodeRuntime.installation() : null;
const v2 = opencode?.kind === "available" && opencode.via === "executable" && await opencodeMajor(opencode) === 2;
const enabled = qoder || backend === "grok-aimock" || v2;
const content = `## Objective\nRetain the synthetic conversation.\n## Work State\n${"The controlled facts remain available. ".repeat(80)}`;
async function fixture(shadowed = false) {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let mode: "normal" | "hold" | "fail" = "normal";
  const runtime = qoder ? qoderRuntime : (backend === "grok-aimock" ? grokRuntime : opencodeRuntime);
  const native = qoder ? await startQoderNative(Array.from({ length: 12 }, () => ({ text: content, input: 10_000, output: 1000 }))) : null;
  const configure = (mock: LLMock): void => {
    mock.onMessage(/[\s\S]*/u, async () => {
      if (mode === "hold") { entered.resolve(); await release.promise; }
      if (mode === "fail") { return { error: { message: "OAR_NATIVE_COMPACT_FAILURE", type: "invalid_request_error" }, status: 400 }; }
      return { content, usage: { input_tokens: 10_000, output_tokens: 1000 } };
    });
  };
  const provider = qoder ? null : await (backend === "grok-aimock" ? startGrokAimock(configure) : startOpencodeAimock(configure, shadowed ? { commands: { compact: { template: "OAR_COMPACT_OVERRIDE", description: "Same-name user command" }, "oar-proof": { template: "OAR_ORDINARY_COMMAND", description: "OAR_COMMAND_CONFIGURATION_LOADED" } } } : {}));
  const options = native?.options ?? { cwd: provider?.env.HOME ?? "", env: provider?.env ?? {} };
  if (qoder && shadowed) { const directory = path.join(options.cwd, ".qoder", "commands"); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "compact.md"), "Reply only OAR_COMPACT_OVERRIDE."); await writeFile(path.join(directory, "oar-proof.md"), "Reply only OAR_COMMAND_CONFIGURATION_LOADED."); }
  const installation = await runtime.installation(); assert.ok(installation.kind === "available");
  const sessions: Session[] = [];
  onTestFailed(async () => { await mkdir("oar-trial-run/manual-compaction-followup", { recursive: true }); await writeFile(`oar-trial-run/manual-compaction-followup/${backend ?? "unknown"}.json`, JSON.stringify({ raw: provider?.raw, sessions: sessions.map(s => s.records()) }, null, 2)); });
  return {
    open: async () => { const s = await runtime.session(installation, { ...options, ...(qoder ? { model: "efficient" } : {}) }); sessions.push(s); const compact = s.compact?.bind(s); assert.ok(compact !== undefined); return { ...s, compact }; },
    hold: () => { mode = "hold"; }, fail: () => { mode = "fail"; }, entered: async () => entered.promise,
    requests: () => provider?.raw ?? [],
    release: () => { mode = "normal"; release.resolve(); },
    close: async () => { mode = "normal"; release.resolve(); try { for (const s of sessions) { await s.dispose(); } } finally { await provider?.stop(); await native?.stop(); } },
  };
}
async function seed(session: Session) {
  const one = await promptAndWait(session, "OAR_SEED_ONE", { timeoutMs: 30_000 }); expect(one.kind).toBe("ended");
  const two = await promptAndWait(session, "OAR_SEED_TWO", { timeoutMs: 30_000 }); expect(two.kind).toBe("ended");
}
describe.skipIf(!enabled)("native followup manual compaction", () => {
  test.each(backend === "grok-aimock" ? [false] : [false, true])("native boundary proves completion, same-name command configured: %s", async (shadowed) => {
    const f = await fixture(shadowed);
    try {
      const session = await f.open(); await seed(session);
      if (shadowed) { expect(JSON.stringify(session.records()), "native catalog must prove the command configuration loaded").toContain(qoder ? "oar-proof" : "OAR_COMMAND_CONFIGURATION_LOADED"); }
      const before = session.records().length;
      const result = await session.compact({ timeoutMs: 30_000 });
      expect(result.kind, JSON.stringify(session.records().slice(before))).toBe("completed");
      assert.ok(result.kind === "completed"); expect(session.records()).toContain(result.frame);
      expect(result.frame.body.events.some(event => event.kind === "compaction_ended" && event.outcome === "completed")).toBe(true);
      expect(session.records().slice(before).some(r => r.kind === "request" && r.body.kind === "prompt")).toBe(false);
      expect(session.status().value.kind).toBe("idle");
      const next = await promptAndWait(session, "OAR_AFTER_COMPACT", { timeoutMs: 30_000 }); expect(next.kind).toBe("ended");
    } finally { await f.close(); }
  }, 120_000);
  test("empty history never borrows a successful ordinary result as compaction evidence", async () => {
    const f = await fixture();
    try {
      const session = await f.open();
      expect(await session.compact({ timeoutMs: 30_000 })).toMatchObject(backend === "grok-aimock" ? { kind: "completed" } : { kind: "failed", code: qoder ? "not_compacted" : "native_failed" });
      expect(session.status().value.kind).toBe("idle");
    } finally { await f.close(); }
  }, 120_000);
  test.skipIf(qoder)("native provider failure is separate from the ordinary prompt result", async () => {
    const f = await fixture();
    try { const s = await f.open(); await seed(s); f.fail(); expect(await s.compact({ timeoutMs: 30_000 })).toMatchObject({ kind: "failed", code: "native_failed" }); expect(s.status().value.kind).toBe("idle"); }
    finally { await f.close(); }
  }, 120_000);
  test.skipIf(qoder)("timeout holds the input gate until native completion, then drains queue in order", async () => {
    const f = await fixture();
    try {
      const s = await f.open(); await seed(s); f.hold();
      const waiting = s.compact({ timeoutMs: 100 }); await f.entered();
      expect(await waiting).toMatchObject({ kind: "unconfirmed", code: "timeout" });
      expect(await s.compact()).toMatchObject({ kind: "rejected", code: "busy" });
      expect(await s.prompt("refused")).toMatchObject({ kind: "rejected", code: "busy" });
      await s.queue("OAR_QUEUED_AFTER_COMPACT");
      expect(JSON.stringify(f.requests())).not.toContain("OAR_QUEUED_AFTER_COMPACT");
      f.release();
      await vi.waitFor(() => { expect(JSON.stringify(f.requests())).toContain("OAR_QUEUED_AFTER_COMPACT"); expect(s.status().value.kind).toBe("idle"); expect(s.records().some(r => r.kind === "frame" && r.body.events.some(e => e.kind === "compaction_ended"))).toBe(true); }, { timeout: 30_000 });
    } finally { await f.close(); }
  }, 120_000);
  test.skipIf(qoder)("native cancel supplies its own aborted compaction evidence", async () => {
    const f = await fixture();
    try { const s = await f.open(); await seed(s); f.hold(); const waiting = s.compact(); await f.entered(); expect(await s.abort()).toMatchObject({ kind: "accepted" }); const outcome = await waiting; expect(outcome.kind).toBe("aborted"); assert.equal(outcome.kind, "aborted"); expect(s.status().value.kind).toBe("idle"); }
    finally { await f.close(); }
  }, 120_000);
});
