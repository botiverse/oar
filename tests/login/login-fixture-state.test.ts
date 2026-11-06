/* oxlint-disable eslint/max-statements -- Keep the child lifetime and interrupted-state assertions together. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";

const fixtures = [
  { name: "claude", args: ["auth", "logout"] },
  { name: "codex", args: ["--version"] },
  { name: "kimi", args: ["acp"] },
  { name: "qoder", args: ["--version"] },
  { name: "codebuddy", args: [] },
];

const interruptions = fixtures.flatMap(({ name, args }) => ["empty", "partial"].map((stage) => ({ name, args, stage })));

test.each(interruptions)("$name keeps its last complete state when killed at the $stage write", async ({ name, args, stage }) => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-login-state-"));
  const initial = { version: "fixture", loggedIn: true, marker: "previous complete state" };
  const script = `fake-${name}-login.mjs`;
  const fake = fakeLoginCli({ dir, name, script, state: initial });
  const fixtureDir = path.resolve(import.meta.dirname, "../fixtures");
  const child = spawn(process.execPath, [
    "--import", pathToFileURL(path.join(fixtureDir, "pause-login-state-write.mjs")).href,
    path.join(fixtureDir, script), path.join(dir, `${name}.json`), ...args,
  ], {
    env: { ...process.env, OAR_LOGIN_WRITE_STAGE: stage },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  try {
    const messages: readonly unknown[] = await Promise.race([
      once(lines, "line", { signal: AbortSignal.timeout(10_000) }),
      closed.then((result) => { throw new Error(`fixture exited before the write checkpoint: ${JSON.stringify(result)} ${stderr}`); }),
    ]);
    assert.equal(messages[0], "state-write-paused");
    assert.ok(child.kill("SIGKILL"), "the paused fixture must still be running");
    await closed;
    expect(fake.read()).toEqual(initial);
  } finally {
    child.kill("SIGKILL");
    await closed;
    lines.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
