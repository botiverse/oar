import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { dshRuntime, type Session } from "../../packages/oar/src/index.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

const dir = mkdtempSync(path.join(tmpdir(), "oar-dsh-session-file-"));
const command = fakeAgentBinary(dir, [path.resolve(import.meta.dirname, "../fixtures/fake-dsh.mjs")]);
const installation = { kind: "available", via: "executable", command, version: "0.2.2-rc.5" } as const;
afterAll(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

async function runOneTurn(session: Session): Promise<void> {
  const started = await session.prompt("save");
  expect(started.kind).toBe("accepted");
  await awaitTurnEnd(session, started.seq);
}

test("dshRuntime declares nativeSessionFile and locates the file before and after disposal", async () => {
  expect(dshRuntime.sessionCapabilities(installation).nativeSessionFile).toBe(true);
  const template = path.join(dir, "{id}.v4.jsonl.zstd");
  const session = await dshRuntime.session(installation, { cwd: dir, env: { FAKE_DSH_SESSION_FILE: template } });
  const expected = template.replace("{id}", session.id);
  expect(await session.nativeSessionFile?.()).toBeNull();
  await runOneTurn(session);
  expect(await session.nativeSessionFile?.()).toBe(expected);
  await session.dispose();
  expect(await session.nativeSessionFile?.()).toBe(expected);
});

test("nativeSessionFile still resolves after disposal when never called before dispose", async () => {
  const template = path.join(dir, "dispose-only-{id}.v4.jsonl.zstd");
  const session = await dshRuntime.session(installation, { cwd: dir, env: { FAKE_DSH_SESSION_FILE: template } });
  const expected = template.replace("{id}", session.id);
  await runOneTurn(session);
  await session.dispose();
  expect(await session.nativeSessionFile?.()).toBe(expected);
});

test("nativeSessionFile returns null if the reported path does not exist", async () => {
  const missingFile = path.join(dir, "ghost-{id}.v4.jsonl.zstd");
  const session = await dshRuntime.session(installation, {
    cwd: dir,
    env: { FAKE_DSH_SESSION_FILE: missingFile, FAKE_DSH_SESSION_FILE_WRITE: "0" },
  });
  await runOneTurn(session);
  expect(await session.nativeSessionFile?.()).toBeNull();
  await session.dispose();
});

test("nativeSessionFile is omitted when sessionPersistence.stat is missing", async () => {
  const noStat = await dshRuntime.session(installation, {
    cwd: dir,
    env: { FAKE_DSH_MISSING: "stat", FAKE_DSH_SESSION_FILE: path.join(dir, "pre-{id}.v4.jsonl.zstd") },
  });
  expect(typeof noStat.nativeSessionFile).toBe("undefined");
  await noStat.dispose();
});

test("resumed DSH sessions report an existing session file before any new turn", async () => {
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const file = path.join(dir, `resumed-${sessionId}.v4.jsonl.zstd`);
  writeFileSync(file, "{\"type\":\"session\"}\n");
  const resumed = await dshRuntime.session(installation, {
    cwd: dir,
    resume: sessionId,
    env: { FAKE_DSH_SESSION_FILE: file, FAKE_DSH_SESSION_FILE_AT_OPEN: "1" },
  });
  expect(await resumed.nativeSessionFile?.()).toBe(file);
  await resumed.dispose();
  expect(await resumed.nativeSessionFile?.()).toBe(file);
});

test("nativeSessionFile re-queries stat on each live call when the selected generation changes", async () => {
  const template = path.join(dir, "gen-{turn}-{id}.jsonl.zstd");
  const session = await dshRuntime.session(installation, { cwd: dir, env: { FAKE_DSH_SESSION_FILE: template } });
  await runOneTurn(session);
  expect(await session.nativeSessionFile?.()).toBe(template.replace("{id}", session.id).replace("{turn}", "1"));
  await runOneTurn(session);
  expect(await session.nativeSessionFile?.()).toBe(template.replace("{id}", session.id).replace("{turn}", "2"));
  await session.dispose();
  expect(await session.nativeSessionFile?.()).toBe(template.replace("{id}", session.id).replace("{turn}", "2"));
});

test("nativeSessionFile keeps the last known path when post-dispose stat fails", async () => {
  const template = path.join(dir, "keep-{id}.v4.jsonl.zstd");
  const session = await dshRuntime.session(installation, {
    cwd: dir,
    env: { FAKE_DSH_SESSION_FILE: template, FAKE_DSH_STAT_THROW_AFTER_DISPOSE: "1" },
  });
  const expected = template.replace("{id}", session.id);
  await runOneTurn(session);
  expect(await session.nativeSessionFile?.()).toBe(expected);
  await session.dispose();
  expect(await session.nativeSessionFile?.()).toBe(expected);
});

test("nativeSessionFile flushes buffered post-turn events without materializing an empty session", async () => {
  const template = path.join(dir, "buffered-{id}.v4.jsonl.zstd");
  const session = await dshRuntime.session(installation, {
    cwd: dir,
    env: { FAKE_DSH_SESSION_FILE: template, FAKE_DSH_BUFFER_UNTIL_FLUSH: "1" },
  });
  expect(await session.nativeSessionFile?.()).toBeNull();
  await runOneTurn(session);
  expect(await session.nativeSessionFile?.()).toBe(template.replace("{id}", session.id));
  await session.dispose();
});
