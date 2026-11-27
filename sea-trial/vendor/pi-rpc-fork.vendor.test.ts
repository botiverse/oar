import { piRpcTestOptions } from "../harness/pi-rpc.js";
/* oxlint-disable import/max-dependencies -- Native process evidence and the shared provider fixture. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { createPiRuntime, promptAndWait, type RawEvent, type Session, type SessionOptions } from "../../packages/oar/src/index.js";
import { viewOf, type ViewTurn } from "../../packages/oar/src/observe/session-view.js";
import { piSessionDir } from "../../packages/oar/src/runtimes/pi/resolve.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startPiAimock, type AimockEnv } from "../harness/aimock.js";
import { piChildCwd } from "./support/pi-runtime.js";

const runtime = createPiRuntime(piRpcTestOptions());

/** The root turns the session ended, in order (the anchors' source). */
function endedTurns(records: readonly RawEvent[]): ViewTurn[] {
  return viewOf(records).messages.filter((message): message is ViewTurn => message.kind === "turn" && message.outcome !== undefined);
}

/** The native RPC commands the child answered, in order. */
function nativeCommands(records: readonly RawEvent[]): string[] {
  return records.flatMap((record) => {
    const native = record.kind === "frame" ? asRecord(record.body.native) : null;
    return typeof native?.command === "string" ? [native.command] : [];
  });
}

/** The provider request the last turn sent: the history the runtime replayed for it. */
function lastRequestBody(env: AimockEnv): string {
  return JSON.stringify(env.raw.at(-1)?.body);
}

/** The provider request that carried `marker` last. */
function requestWith(env: AimockEnv, marker: string): unknown {
  const found = env.raw.findLast((request) => JSON.stringify(request).includes(marker));
  if (found === undefined) { throw new Error(`no provider request carried ${marker}`); }
  return found;
}

/** The conversation a provider request carried before the prompt that sent it. */
function historyOf(request: unknown): unknown {
  const body = asRecord(asRecord(request)?.body);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.slice(0, -1);
}

async function fixture(extension = "", settings?: Readonly<Record<string, unknown>>) {
  const env = await startPiAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "noted" }); },
    { captureRaw: true, ...(settings === undefined ? {} : { settings }) });
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  assert.ok(agentDir !== undefined);
  const cwd = path.join(agentDir, "fork-project");
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(agentDir, "extensions"), { recursive: true });
  if (extension !== "") {
    await writeFile(path.join(agentDir, "extensions", "fork-guard.ts"), `export default async (pi) => { ${extension} };`);
  }
  const sessions: Session[] = [];
  const installation = await runtime.installation();
  assert.ok(installation.kind === "available");
  return { env, agentDir, cwd,
    async open(options: Partial<SessionOptions> = {}) {
      const session = await runtime.session(installation, { cwd, ...(options.resume === undefined ? { model: "aimock/aimock-model" } : {}), ...options, env: { ...env.env, ...options.env } });
      sessions.push(session);
      return session;
    },
    async stop() {
      try { await Promise.all(sessions.map(async (session) => session.dispose())); }
      finally { await env.stop(); }
    },
  };
}

async function turn(session: Session, input: string): Promise<void> {
  expect(await promptAndWait(session, input, { timeoutMs: 30_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
}

/**
 * `SessionOptions.fork.through` on the real bundled Pi RPC child: Pi 1.6's own
 * `fork { entryId }` copies the branch into a NEW session file, so the copy
 * holds the turns through the anchor and the source file stays byte-identical
 * and resumable. Every step reads the child's own reports: the anchors are the
 * entry ids the child returned at settlement, the cut is what the provider
 * received for the copy's next prompt.
 */
describe.skipIf(process.env.OAR_TEST !== "pi-rpc-aimock")("pi RPC anchored fork", () => {
  test("a fork through an earlier turn copies only the turns through it and leaves the source intact", async () => {
    const f = await fixture();
    try {
      const source = await f.open();
      await turn(source, "SOURCE-APPLE");
      await turn(source, "SOURCE-BANANA");
      const [first, second] = endedTurns(source.records());
      const firstAnchor = first?.forkAnchor;
      const secondAnchor = second?.forkAnchor;
      expect(typeof firstAnchor).toBe("string");
      expect(typeof secondAnchor).toBe("string");
      expect(firstAnchor).not.toBe(secondAnchor);
      const sourceFile = await source.nativeSessionFile?.();
      assert.ok(typeof sourceFile === "string");
      // Both anchors are real entries of the source's own session file.
      const file = readFileSync(sourceFile, "utf8");
      expect(file).toContain(String(firstAnchor));
      expect(file).toContain(String(secondAnchor));
      await source.dispose();
      const before = readFileSync(sourceFile, "utf8");

      const copy = await f.open({ resume: source.id, fork: { through: String(firstAnchor) } });
      expect(copy.id).not.toBe(source.id);
      // The copy is Pi's own `fork`, not the whole-session `clone`.
      expect(nativeCommands(copy.records())).toContain("fork");
      await turn(copy, "COPY-QUESTION");
      const copied = lastRequestBody(f.env);
      expect(copied).toContain("SOURCE-APPLE");
      expect(copied).not.toContain("SOURCE-BANANA");
      const copyFile = await copy.nativeSessionFile?.();
      expect(copyFile).not.toBe(sourceFile);
      await copy.dispose();
      // The source's file is byte-identical after a fork and after the copy ran.
      expect(readFileSync(sourceFile, "utf8")).toBe(before);

      const resumed = await f.open({ resume: source.id });
      expect(resumed.id).toBe(source.id);
      await turn(resumed, "SOURCE-QUESTION");
      const sourceHistory = lastRequestBody(f.env);
      expect(sourceHistory).toContain("SOURCE-APPLE");
      expect(sourceHistory).toContain("SOURCE-BANANA");
      expect(sourceHistory).not.toContain("COPY-QUESTION");
    } finally { await f.stop(); }
  }, 180_000);

  test("a fork through the last turn copies the whole conversation", async () => {
    const f = await fixture();
    try {
      const source = await f.open();
      await turn(source, "SOURCE-APPLE");
      await turn(source, "SOURCE-BANANA");
      const lastAnchor = endedTurns(source.records())[1]?.forkAnchor;
      expect(typeof lastAnchor).toBe("string");
      await source.dispose();
      const copy = await f.open({ resume: source.id, fork: { through: String(lastAnchor) } });
      expect(copy.id).not.toBe(source.id);
      expect(nativeCommands(copy.records())).toContain("clone");
      await turn(copy, "COPY-QUESTION");
      const copied = lastRequestBody(f.env);
      expect(copied).toContain("SOURCE-APPLE");
      expect(copied).toContain("SOURCE-BANANA");
    } finally { await f.stop(); }
  }, 180_000);

  test("a fork through a turn before a manual compaction keeps the turns and cuts before the next one", async () => {
    // A tiny keepRecentTokens lets Pi's manual compaction find something to summarize.
    const f = await fixture("", { compaction: { keepRecentTokens: 1 } });
    try {
      const source = await f.open();
      await turn(source, "SOURCE-APPLE");
      await turn(source, "SOURCE-BANANA");
      await expect(source.compact?.()).resolves.toMatchObject({ kind: "completed" });
      await turn(source, "SOURCE-CHERRY");
      const anchor = endedTurns(source.records())[1]?.forkAnchor;
      expect(typeof anchor).toBe("string");
      const sourceFile = await source.nativeSessionFile?.();
      assert.ok(typeof sourceFile === "string");
      await source.dispose();
      const before = readFileSync(sourceFile, "utf8");
      const copy = await f.open({ resume: source.id, fork: { through: String(anchor) } });
      await turn(copy, "COPY-QUESTION");
      // The copy replays the source's compacted context (the summary stands in
      // for the two turns) and nothing after the anchor, exactly as the
      // source's own post-compaction turn did.
      const copyHistory = JSON.stringify(historyOf(requestWith(f.env, "COPY-QUESTION")));
      expect(JSON.parse(copyHistory)).toEqual(historyOf(requestWith(f.env, "SOURCE-CHERRY")));
      expect(copyHistory).toContain("summary");
      expect(JSON.stringify(requestWith(f.env, "COPY-QUESTION"))).not.toContain("SOURCE-CHERRY");
      await copy.dispose();
      expect(readFileSync(sourceFile, "utf8")).toBe(before);
    } finally { await f.stop(); }
  }, 180_000);

  test("an anchor the source does not hold fails the open instead of copying something else", async () => {
    const f = await fixture();
    try {
      const source = await f.open();
      await turn(source, "SOURCE-APPLE");
      await source.dispose();
      await expect(f.open({ resume: source.id, fork: { through: "not-an-entry" } }))
        .rejects.toThrow("Pi session has no entry not-an-entry to fork through");
    } finally { await f.stop(); }
  }, 150_000);

  test("a copy the source's own extension cancels never becomes a session", async () => {
    const f = await fixture('pi.on("session_before_fork", async () => ({ cancel: true }));');
    try {
      const source = await f.open();
      await turn(source, "SOURCE-APPLE");
      await turn(source, "SOURCE-BANANA");
      const firstAnchor = endedTurns(source.records())[0]?.forkAnchor;
      expect(typeof firstAnchor).toBe("string");
      await source.dispose();
      await expect(f.open({ resume: source.id, fork: { through: String(firstAnchor) } }))
        .rejects.toThrow("fork was cancelled; the new session id was not confirmed");
    } finally { await f.stop(); }
  }, 180_000);

  test("name names the copy, through the child's own session name, and never the source", async () => {
    const f = await fixture();
    try {
      const named = async (id: string): Promise<string | undefined> => {
        const sessions = await SessionManager.list(piChildCwd(f.cwd), piSessionDir(f.cwd, f.agentDir));
        return sessions.find((info) => info.id === id)?.name;
      };
      const source = await f.open();
      await turn(source, "SOURCE-APPLE");
      const sourceFile = await source.nativeSessionFile?.();
      assert.ok(typeof sourceFile === "string");
      await source.dispose();
      const before = readFileSync(sourceFile, "utf8");

      const copy = await f.open({ resume: source.id, fork: {}, name: "COPY-NAME" });
      expect(copy.id).not.toBe(source.id);
      expect(nativeCommands(copy.records())).toContain("set_session_name");
      await turn(copy, "COPY-QUESTION");
      await copy.dispose();
      // Naming the copy did not touch the source: not its file, not its name.
      expect(readFileSync(sourceFile, "utf8")).toBe(before);
      expect(await named(source.id)).toBeUndefined();
      expect(await named(copy.id)).toBe("COPY-NAME");
      const copyFile = await readFile(String(await copy.nativeSessionFile?.()), "utf8");
      expect(copyFile).toContain("COPY-NAME");
    } finally { await f.stop(); }
  }, 180_000);
});
