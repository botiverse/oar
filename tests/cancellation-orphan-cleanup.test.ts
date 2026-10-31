/* oxlint-disable import/max-dependencies -- Both protocol drivers share the same actual process-tree transition. */
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Session } from "../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import { acpSession } from "../packages/oar/src/shared/acp/session.js";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/process.js";
import { withSessionCredentials } from "../packages/oar/src/shared/session-credentials.js";
import { streamJsonSession } from "../packages/oar/src/shared/stream-json/session.js";
import { claudeProjectionProfile, initialClaudeProjection, resumedClaudeProjection } from "../packages/oar/src/runtimes/claude/projection.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
// oxlint-disable-next-line import/no-namespace -- Hold one observation while native protocol events continue.
import * as tables from "../packages/oar/src/shared/executable/process-table-async.js";
import type { ProcessTableObservation } from "../packages/oar/src/shared/executable/process-tree.js";
import { gone } from "./fixtures/process-tree.js";

const fixture = fileURLToPath(new URL("fixtures/cancellation-orphan-agent.mjs", import.meta.url));
const installation = { kind: "available", via: "executable", command: process.execPath } as const;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function open(protocol: string, resume: boolean): Promise<Session> {
  if (protocol === "acp") {
    return acpSession({ args: [fixture, protocol], abortTimeoutMs: 250, capabilities: { queue: { durable: false }, attribution: "opaque" } })(installation,
      { cwd: process.cwd(), ...(resume ? { resume: "cancel-root" } : {}) });
  }
  const child = spawnLineProcess(process.execPath, [fixture, protocol], { killTree: true });
  return withSessionCredentials(async (_installation, _options, credentials) => streamJsonSession(child, "cancel-root", credentials, {
    initial: resume ? resumedClaudeProjection : initialClaudeProjection, projection: claudeProjectionProfile,
    capabilities: { queue: { durable: false }, attribution: "attributed", images: false },
    steer: true, consume: () => false, open: async () => {}, exited: () => {}, disposing: () => {},
  }))(installation, { cwd: process.cwd() });
}
function messages(session: Session, since: number): readonly Record<string, unknown>[] {
  return session.records().flatMap(record => record.kind === "frame" && record.seq > since
    ? record.body.events.flatMap(event => event.kind === "text_delta" ? [asRecord(JSON.parse(event.text)) ?? {}] : []) : []);
}

// oxlint-disable-next-line eslint/max-statements -- Two native turns must leave different orphaned tools before one final disposal.
test.each(["acp", "stream"])("%s cancellation retains orphan identities across two resumed turns", async protocol => {
  const session = await open(protocol, true);
  const owned: number[] = [];
  try {
    for (const round of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop -- The second turn must start after the first cancellation completed.
      const prompt = await session.prompt(`round-${round}`);
      // eslint-disable-next-line no-await-in-loop -- Native readiness, cancellation and the next turn are ordered.
      await expect.poll(() => messages(session, prompt.seq).find(value => typeof value.tool === "number"), { timeout: 10_000 }).toBeDefined();
      const ready = messages(session, prompt.seq).find(value => typeof value.tool === "number");
      const middle = Number(ready?.middle), tool = Number(ready?.tool); owned.push(tool, middle);
      // eslint-disable-next-line no-await-in-loop -- Tool liveness before cancellation is a required assertion.
      expect(await gone(tool, 50)).toBe(false);
      // eslint-disable-next-line no-await-in-loop -- The native cancellation severs the captured parent chain.
      const abortResult = await session.abort();
      expect(abortResult.kind).toBe("accepted");
      // eslint-disable-next-line no-await-in-loop -- No second turn starts until the first ended natively.
      expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "aborted" });
      // eslint-disable-next-line no-await-in-loop -- Verify the actual orphan remains alive until whole-process disposal.
      expect(await gone(middle)).toBe(true);
      // eslint-disable-next-line no-await-in-loop -- Completed turns do not kill their still-live tools.
      expect(await gone(tool, 50)).toBe(false);
    }
    await session.dispose();
    expect(await Promise.all(owned.map(async pid => gone(pid)))).toEqual(owned.map(() => true));
    expect(session.records().filter(record => record.kind === "response" && record.body.kind === "exited")).toHaveLength(1);
  } finally {
    await session.dispose();
    for (const pid of owned) { try { process.kill(pid, "SIGKILL"); } catch { /* Owned fixture already reclaimed. */ } }
  }
});

// oxlint-disable-next-line eslint/max-statements -- Root exit is deliberately immediate after cancel, before a normal prompt reply.
test.each(["acp", "stream"])("%s cancellation cleans captured tools when its root exits immediately", async protocol => {
  vi.stubEnv("OAR_CANCEL_EXIT", "1");
  const session = await open(protocol, false);
  let tool: number | undefined = undefined;
  try {
    const prompt = await session.prompt("exit-on-cancel");
    await expect.poll(() => messages(session, prompt.seq).find(value => typeof value.tool === "number"), { timeout: 10_000 }).toBeDefined();
    tool = Number(messages(session, prompt.seq).find(value => typeof value.tool === "number")?.tool);
    expect(await gone(tool, 50)).toBe(false);
    await session.abort();
    await expect.poll(() => session.records().some(record => record.kind === "response" && record.body.kind === "exited"), { timeout: 10_000 }).toBe(true);
    expect(await gone(tool)).toBe(true);
  } finally {
    await session.dispose();
    if (tool !== undefined) { try { process.kill(tool, "SIGKILL"); } catch { /* Already reclaimed. */ } }
  }
});

// oxlint-disable-next-line eslint/max-statements -- Native A completes while capture is pending, with B already held in OAR's queue.
test("ACP observation expiry releases the next turn without cancelling it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-cancel-turn-"));
  const signal = path.join(dir, "finish");
  vi.stubEnv("OAR_CANCEL_NATURAL_FILE", signal);
  const session = await open("acp", false);
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const owned: number[] = [];
  try {
    const a = await session.prompt("A");
    await expect.poll(() => messages(session, a.seq).find(value => typeof value.tool === "number"), { timeout: 10_000 }).toBeDefined();
    await session.queue("B");
    const entered = Promise.withResolvers<void>();
    const read = vi.spyOn(tables, "observeProcessTableAsync").mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const abort = session.abort();
    await entered.promise;
    await writeFile(signal, "finish native A");
    expect(await awaitTurnEnd(session, a.seq)).toEqual({ kind: "completed" });
    const abortResult = await abort;
    expect(abortResult.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    await expect.poll(() => messages(session, a.seq).filter(value => typeof value.tool === "number").length, { timeout: 10_000 }).toBe(2);
    expect(messages(session, a.seq).some(value => value.cancelled === true)).toBe(false);
    expect(read).toHaveBeenCalledOnce();
  } finally {
    for (const value of messages(session, 0)) { if (typeof value.tool === "number") { owned.push(value.tool, Number(value.middle)); } }
    gate.resolve({ ok: false, source: "windows", reason: "timeout", elapsedMs: 5000, timeoutMs: 5000 });
    vi.restoreAllMocks(); await session.dispose();
    for (const pid of owned) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reclaimed. */ } }
    await rm(dir, { recursive: true, force: true });
  }
});

// oxlint-disable-next-line eslint/max-statements -- A timed-out read must not postpone cancel or turn its late result into prior evidence.
test("ACP sends cancel after one observation timeout and preserves unverified cleanup", async () => {
  const session = await open("acp", false);
  const gate = Promise.withResolvers<ProcessTableObservation>();
  let tool: number | undefined = undefined;
  try {
    const prompt = await session.prompt("A");
    await expect.poll(() => messages(session, prompt.seq).find(value => typeof value.tool === "number"), { timeout: 10_000 }).toBeDefined();
    tool = Number(messages(session, prompt.seq).find(value => typeof value.tool === "number")?.tool);
    const read = vi.spyOn(tables, "observeProcessTableAsync").mockReturnValueOnce(gate.promise);
    const abortResult = await session.abort();
    expect(abortResult.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "aborted" });
    expect(read).toHaveBeenCalledOnce();
    expect(messages(session, prompt.seq).some(value => value.cancelled === true)).toBe(true);
    await session.dispose();
    const exit = session.records().findLast(record => record.kind === "response" && record.body.kind === "exited");
    expect(exit?.kind === "response" && exit.body.kind === "exited" ? exit.body.reason : undefined).toMatch(/before_cancel (?:procfs|windows|ps): timeout/u);
    expect(await gone(tool, 50)).toBe(false);
  } finally {
    gate.resolve({ ok: false, source: "windows", reason: "timeout", elapsedMs: 5000, timeoutMs: 5000 });
    vi.restoreAllMocks(); await session.dispose();
    if (tool !== undefined) { try { process.kill(tool, "SIGKILL"); } catch { /* The unverified fixture tool is ours to reclaim. */ } }
  }
});

// oxlint-disable-next-line eslint/max-statements -- Native cancel orphans the tool and never completes, so the actual fallback must reclaim it.
test.each(["acp", "stream"])("%s kill fallback retains ownership from before the native cancel", async protocol => {
  vi.stubEnv("OAR_CANCEL_HANG", "1");
  const session = await open(protocol, false);
  let tool: number | undefined = undefined;
  try {
    const prompt = await session.prompt("never-finish-cancel");
    await expect.poll(() => messages(session, prompt.seq).find(value => typeof value.tool === "number"), { timeout: 10_000 }).toBeDefined();
    tool = Number(messages(session, prompt.seq).find(value => typeof value.tool === "number")?.tool);
    expect(await gone(tool, 50)).toBe(false);
    const abortResult = await session.abort();
    expect(abortResult.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "aborted" });
    expect(await gone(tool)).toBe(true);
    expect(session.records().filter(record => record.kind === "response" && record.body.kind === "exited")).toHaveLength(1);
  } finally {
    await session.dispose();
    if (tool !== undefined) { try { process.kill(tool, "SIGKILL"); } catch { /* Already reclaimed. */ } }
  }
}, 30_000);
