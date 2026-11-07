/* oxlint-disable import/max-dependencies -- Native controls share provider, resume, and transport synchronization fixtures. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, onTestFailed, test, vi } from "vitest";
import { claudeRuntime, codexRuntime, type Session, type SessionOptions } from "../../packages/oar/src/index.js";
import { removeFixtureDirectory } from "../harness/fixture-directory-cleanup.js";
import { startClaudeAimock, startCodexAimock, startPiAimock } from "../harness/aimock.js";
import { runTurn } from "./support/asserts.js";
import { abortStartedCodexCompaction } from "./support/codex-compaction.js";
import { isPiBackend, piTestRuntime } from "./support/pi-runtime.js";
import { oldPrompts, newPrompts, promptMarkers, requestsForTurn } from "./support/resumed-prompts.js";

const backend = process.env.OAR_TEST;
const enabled = backend === "claude-aimock" || backend === "codex-aimock" || isPiBackend;
async function removeDirectory(directory: string): Promise<void> {
  await (backend === "codex-aimock"
    ? removeFixtureDirectory(directory, "manual-compaction")
    : rm(directory, { recursive: true, force: true }));
}

async function fixture() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  let fail = false;
  const provider = await (backend === "claude-aimock" ? startClaudeAimock : (backend === "codex-aimock" ? startCodexAimock : startPiAimock))((mock) => {
    mock.onMessage(/[\s\S]*/u, async () => {
      if (hold) { entered.resolve(); await release.promise; }
      if (fail) { return { error: { message: "OAR_NATIVE_COMPACTION_REFUSED", type: "invalid_request_error" }, status: 400 }; }
      return { content: `OAR_MANUAL_COMPACTION_SUMMARY ${"A local scripted conversation has been summarized for the next request. ".repeat(100)}`, usage: { input_tokens: 1000, output_tokens: 1000 } };
    });
  }, { captureRaw: true, ...(isPiBackend ? { settings: { compaction: { enabled: false, keepRecentTokens: 500 } } } : {}) });
  const root = await mkdtemp(path.join(tmpdir(), "oar-compact-control-"));
  try {
    const cwd = path.join(root, "project");
    await mkdir(cwd);
    const env = { ...provider.env };
    if (backend === "claude-aimock") { env.CLAUDE_CONFIG_DIR = path.join(root, "claude"); await mkdir(env.CLAUDE_CONFIG_DIR); }
    const runtime = backend === "claude-aimock" ? claudeRuntime : (backend === "codex-aimock" ? codexRuntime : piTestRuntime);
    const installation = await runtime.installation();
    assert.ok(installation.kind === "available");
    const sessions: Session[] = [];
    onTestFailed(async () => {
      await mkdir("oar-trial-run/manual-compaction", { recursive: true });
      await writeFile(`oar-trial-run/manual-compaction/${backend ?? "unknown"}.json`, JSON.stringify({ raw: provider.raw, sessions: sessions.map((session) => session.records()) }, null, 2));
    });
    return {
      runtime, raw: provider.raw, cwd,
      open: async (options: Partial<SessionOptions> = {}) => {
        const session = await runtime.session(installation, { cwd, env, ...(isPiBackend ? { model: "aimock/aimock-model" } : {}), ...options });
        sessions.push(session);
        return session;
      },
      hold: () => { hold = true; },
      entered: async () => entered.promise,
      fail: (value: boolean) => { fail = value; },
      release: () => { hold = false; release.resolve(); },
      close: async () => { hold = false; release.resolve(); try { for (const session of sessions) { await session.dispose(); } } finally { await provider.stop(); await removeDirectory(root); } },
    };
  } catch (error) { release.resolve(); await provider.stop(); await removeDirectory(root); throw error; }
}

async function seed(session: Session) {
  expect(await runTurn(session, "OAR_MANUAL_SEED_ONE")).toEqual({ kind: "completed" });
  expect(await runTurn(session, "OAR_MANUAL_SEED_TWO")).toEqual({ kind: "completed" });
}

describe.skipIf(!enabled)("native manual compaction control", () => {
  test("resumed prompts become effective before the next user request, with native completion evidence", async () => {
    const f = await fixture();
    try {
      expect(f.runtime.manualCompaction).toEqual({ kind: "supported", activeTurn: "reject" });
      const initial = await f.open(oldPrompts);
      await seed(initial);
      await initial.dispose();
      const session = await f.open({ ...newPrompts, resume: initial.id });
      assert.ok(session.compact !== undefined);
      const before = session.records().length;
      const outcome = await session.compact({ timeoutMs: 30_000 });
      expect(outcome, JSON.stringify(session.records().slice(before))).toMatchObject({ kind: "completed", request: { body: { kind: "compact" } }, response: { body: { kind: "accepted" } } });
      assert.ok(outcome.kind === "completed");
      expect(outcome.frame.body.events).toContainEqual(expect.objectContaining({ kind: "compaction_ended", outcome: "completed" }));
      expect(session.records()).toContain(outcome.frame);
      expect(session.records().slice(before).some((record) => record.kind === "request" && record.body.kind === "prompt")).toBe(false);
      expect(session.status().value.kind).toBe("idle");
      const from = f.raw.length;
      expect(await runTurn(session, "OAR_AFTER_EXPLICIT_COMPACT")).toEqual({ kind: "completed" });
      const requests = requestsForTurn(f.raw.slice(from), "OAR_AFTER_EXPLICIT_COMPACT");
      expect(requests.length).toBeGreaterThan(0);
      for (const { system } of requests) {
        expect(promptMarkers.filter((marker) => system.includes(marker)).toSorted()).toEqual(Object.values(newPrompts).toSorted());
      }
    } finally { await f.close(); }
  }, 120_000);

  test.each(["timeout", "signal"] as const)("%s stops waiting but retains busy state, refuses another compaction, and preserves later native completion", async (mode) => {
    const f = await fixture();
    try {
      const session = await f.open();
      await seed(session);
      assert.ok(session.compact !== undefined);
      f.hold();
      const controller = new AbortController();
      const waiting = session.compact(mode === "timeout" ? { timeoutMs: 100 } : { signal: controller.signal });
      await f.entered();
      if (mode === "signal") { controller.abort(); }
      expect(await waiting).toMatchObject({ kind: "unconfirmed", code: mode });
      expect(session.status().value).toMatchObject({ kind: "running", phase: "compacting" });
      expect(await session.compact()).toMatchObject({ kind: "rejected", code: "busy" });
      expect(await session.prompt("OAR_REFUSED_DURING_COMPACT")).toMatchObject({ kind: "rejected", code: "busy" });
      const queued = await session.queue("OAR_QUEUED_AFTER_COMPACT");
      expect(queued.kind).toBe(backend === "codex-aimock" ? "rejected" : "accepted");
      if (queued.kind === "rejected") { expect(queued.code).toBe("busy"); }
      expect(requestsForTurn(f.raw, "OAR_QUEUED_AFTER_COMPACT")).toEqual([]);
      f.release();
      await vi.waitFor(() => {
        expect(session.status().value.kind).toBe("idle");
        expect(session.records().some((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "compaction_ended" && event.outcome === "completed"))).toBe(true);
        if (queued.kind === "accepted") { expect(requestsForTurn(f.raw, "OAR_QUEUED_AFTER_COMPACT").length).toBeGreaterThan(0); }
      }, { timeout: 30_000 });
      expect(requestsForTurn(f.raw, "OAR_REFUSED_DURING_COMPACT")).toEqual([]);
    } finally { await f.close(); }
  }, 120_000);

  test("dispose releases an unfinished compaction without synthesizing a native terminal", async () => {
    const f = await fixture();
    try {
      const session = await f.open();
      await seed(session);
      assert.ok(session.compact !== undefined);
      f.hold();
      const waiting = session.compact();
      await f.entered();
      await session.dispose();
      expect(await waiting).toMatchObject({ kind: "unconfirmed", code: "disposed" });
      expect(await session.compact()).toMatchObject({ kind: "rejected", code: backend === "pi-aimock" ? "disposed" : "runtime_exited" });
      expect(session.records().some((record) => record.kind === "frame" && record.body.type === "pi/compact_rejected")).toBe(false);
      const terminal = session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "compaction_ended") : []);
      expect(terminal.every((event) => event.outcome === "aborted")).toBe(true);
    } finally { await f.close(); }
  }, 120_000);

  test("abort interrupts native compaction and keeps the session usable", async () => {
    const f = await fixture();
    try {
      const session = await f.open(); await seed(session);
      assert.ok(session.compact !== undefined);
      f.hold();
      const before = session.records().at(-1)?.seq ?? -1;
      const waiting = session.compact({ timeoutMs: 30_000 });
      await f.entered();
      expect(session.status().value).toMatchObject({ kind: "running", phase: "compacting" });
      const aborted = await (backend === "codex-aimock" ? abortStartedCodexCompaction(session, before) : session.abort());
      expect(aborted, JSON.stringify({ aborted, records: session.records().filter((record) => record.seq > before) })).toMatchObject({ kind: "accepted" });
      expect(await waiting, JSON.stringify(session.records())).toMatchObject(backend === "claude-aimock"
        ? { kind: "failed", code: "native_failed", frame: { body: { native: { compact_result: "failed" } } } }
        : { kind: "aborted" });
      await vi.waitFor(() => { expect(session.status().value.kind).toBe("idle"); });
      expect(session.records().some((record) => record.kind === "response" && record.body.kind === "exited")).toBe(false);
      f.release();
      expect(await runTurn(session, "OAR_AFTER_ABORTED_COMPACT")).toEqual({ kind: "completed" });
    } finally { await f.close(); }
  }, 120_000);

  test("an already aborted signal refuses before any native request", async () => {
    const f = await fixture();
    try {
      const session = await f.open(); await seed(session);
      assert.ok(session.compact !== undefined);
      const controller = new AbortController(); controller.abort();
      const before = f.raw.length;
      expect(await session.compact({ signal: controller.signal })).toMatchObject({ kind: "rejected", code: "aborted" });
      expect(f.raw).toHaveLength(before);
      expect(session.status().value.kind).toBe("idle");
    } finally { await f.close(); }
  }, 120_000);

  test("native failure stays a failure and releases the slot for the next input", async () => {
    const f = await fixture();
    try {
      const session = await f.open();
      await seed(session);
      assert.ok(session.compact !== undefined);
      f.fail(true);
      const outcome = await session.compact({ timeoutMs: 30_000 });
      expect(outcome, JSON.stringify(session.records())).toMatchObject({ kind: "failed", code: "native_failed" });
      expect(session.status().value.kind).toBe("idle");
      f.fail(false);
      expect(await runTurn(session, "OAR_AFTER_COMPACTION_FAILURE")).toEqual({ kind: "completed" });
    } finally { await f.close(); }
  }, 120_000);

  test("an active ordinary reply is preserved when compaction is refused", async () => {
    const f = await fixture();
    try {
      const session = await f.open();
      assert.ok(session.compact !== undefined);
      f.hold();
      const turn = runTurn(session, "OAR_ACTIVE_BEFORE_COMPACT");
      await f.entered();
      expect(await session.compact()).toMatchObject({ kind: "rejected", code: "busy" });
      expect(session.records().some((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "compaction_started" || event.kind === "compaction_ended"))).toBe(false);
      f.release();
      expect(await turn).toEqual({ kind: "completed" });
    } finally { await f.close(); }
  }, 120_000);

  test.skipIf(backend !== "claude-aimock")("Claude refuses a project compact command without sending its custom prompt", async () => {
    const f = await fixture();
    try {
      const commands = path.join(f.cwd, ".claude", "commands");
      await mkdir(commands, { recursive: true });
      await writeFile(path.join(commands, "compact.md"), "Return OAR_CUSTOM_COMPACT_MUST_NOT_RUN.");
      const session = await f.open();
      await seed(session);
      assert.ok(session.compact !== undefined);
      const before = f.raw.length;
      expect(await session.compact()).toMatchObject({ kind: "rejected", code: "unsupported" });
      expect(f.raw).toHaveLength(before);
      expect(session.status().value.kind).toBe("idle");
    } finally { await f.close(); }
  }, 120_000);
});
