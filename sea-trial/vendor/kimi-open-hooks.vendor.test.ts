import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { kimiInstallation, type Session } from "../../packages/oar/src/index.js";
import { kimiAcpProfile } from "../../packages/oar/src/runtimes/kimi/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { startKimiAimock } from "../harness/aimock-acp.js";
import { hookMarks, processRunning, sessionStartHook } from "./support/session-start-hook.js";

// Keep request timeout < hook delay < opening timeout: new and cold resume
// must fail if either accidentally uses the ordinary request timeout. Allow
// slow macOS cold starts enough time to initialize before testing the hook.
const open = acpSession({ ...kimiAcpProfile, requestTimeoutMs: 20_000, sessionStartTimeoutMs: 32_000 });

async function fixture(delayMs: number) {
  const provider = await startKimiAimock(() => {});
  const directory = provider.env.KIMI_CODE_HOME;
  assert.ok(directory !== undefined && directory !== "");
  const hook = sessionStartHook(directory, delayMs);
  await writeFile(path.join(directory, "config.toml"), `[[hooks]]\nevent = "SessionStart"\ncommand = ${JSON.stringify(hook.command)}\ntimeout = 60\n`);
  const installation = await kimiInstallation();
  assert.equal(installation.kind, "available");
  return { provider, hook, installation, options: { cwd: directory, env: provider.env } };
}

test.skipIf(process.env.OAR_TEST !== "kimi-aimock")("Kimi real SessionStart hooks delay new and cold resume without hook progress or model calls", async () => {
  const env = await fixture(24_000);
  let current: Session | undefined = undefined;
  try {
    current = await open(env.installation, env.options);
    const id = current.id;
    await current.dispose();
    current = await open(env.installation, { ...env.options, resume: id });
    expect(current.id).toBe(id);
    expect(current.records().some((record) => record.kind === "frame" && /hook/u.test(record.body.type))).toBe(false);
    const marks = await hookMarks(env.hook.file);
    expect(marks.map(({ phase, source }) => ({ phase, source }))).toEqual([
      { phase: "start", source: "startup" }, { phase: "end", source: "startup" },
      { phase: "start", source: "resume" }, { phase: "end", source: "resume" },
    ]);
    expect(env.provider.mock.getRequests()).toEqual([]);
  } finally { await current?.dispose(); await env.provider.stop(); }
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "kimi-aimock")("Kimi kills the process tree when a real SessionStart hook outlasts the fixed opening bound", async () => {
  const env = await fixture(45_000);
  const opened: { session?: Session } = {};
  try {
    const failure: unknown = await open(env.installation, env.options).then((session) => { opened.session = session; return session; }, (error: unknown) => error);
    expect(failure).toMatchObject({ kind: "timeout", method: "session/new", timeoutMs: 32_000 });
    const marks = await hookMarks(env.hook.file);
    expect(marks.map(({ phase }) => phase)).toEqual(["start"]);
    const pid = marks[0]?.pid;
    assert.ok(typeof pid === "number");
    await vi.waitFor(() => { expect(processRunning(pid)).toBe(false); }, { timeout: 10_000 });
    expect(env.provider.mock.getRequests()).toEqual([]);
  } finally { await opened.session?.dispose(); await env.provider.stop(); }
}, 120_000);
