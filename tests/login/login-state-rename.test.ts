/* oxlint-disable max-statements -- Keep child lifetime, publication and cleanup assertions together. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";

const initial = { mode: "success", loggedIn: false, marker: "previous complete snapshot" };

function controlled(options: { readonly failures: number; readonly code?: string; readonly platform?: string; readonly pause?: boolean }) {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-login-rename-"));
  const fake = fakeLoginCli({ dir, name: "kimi", script: "fake-kimi-login.mjs", state: initial });
  const fixtureDir = path.resolve(import.meta.dirname, "../fixtures");
  const trace = path.join(dir, "rename.jsonl");
  const child = spawn(process.execPath, [
    "--import", pathToFileURL(path.join(fixtureDir, "fail-login-state-rename.mjs")).href,
    path.join(fixtureDir, "fake-kimi-login.mjs"), path.join(dir, "kimi.json"), "login",
  ], {
    env: { ...process.env, OAR_RENAME_TRACE: trace,
      OAR_RENAME_FAILURES: String(options.failures), OAR_RENAME_CODE: options.code ?? "EPERM",
      OAR_RENAME_PLATFORM: options.platform ?? "win32", OAR_RENAME_PAUSE: options.pause === true ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = once(child, "close");
  const records = (): readonly unknown[] => readFileSync(trace, "utf8").trim().split("\n").map((line): unknown => JSON.parse(line));
  const cleanup = async () => {
    child.kill("SIGKILL"); await closed;
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, fake, child, closed, records, stderr: () => stderr, cleanup };
}

test("Windows sharing refusals keep the old snapshot until a bounded retry publishes the complete new state", async () => {
  const run = controlled({ failures: 2 });
  try {
    expect(await run.closed, run.stderr()).toEqual([0, null]);
    expect(run.fake.read()).toMatchObject({ loggedIn: true, calls: [["login"]], marker: initial.marker });
    expect(run.records()).toEqual([
      { kind: "refused", state: initial }, { kind: "wait", milliseconds: 25 },
      { kind: "refused", state: initial }, { kind: "wait", milliseconds: 25 },
      { kind: "renamed" }, { kind: "renamed" }, { kind: "renamed" },
    ]);
    expect(readdirSync(run.dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  } finally { await run.cleanup(); }
});

test.each([
  { label: "persistent Windows EPERM", code: "EPERM", platform: "win32", attempts: 11 },
  { label: "another Windows error", code: "EIO", platform: "win32", attempts: 1 },
  { label: "non-Windows EPERM", code: "EPERM", platform: "linux", attempts: 1 },
])("$label still fails without publishing or hiding the original error", async ({ code, platform, attempts }) => {
  const run = controlled({ failures: 100, code, platform });
  try {
    expect(await run.closed).toEqual([1, null]);
    expect(run.stderr()).toContain("controlled state rename refusal");
    expect(run.stderr()).toContain(`code: '${code}'`);
    expect(run.fake.read()).toEqual(initial);
    const expected: unknown[] = [];
    for (let i = 0; i < attempts; i++) {
      expected.push({ kind: "refused", state: initial });
      if (i + 1 < attempts) { expected.push({ kind: "wait", milliseconds: 25 }); }
    }
    expect(run.records()).toEqual(expected);
    expect(readdirSync(run.dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  } finally { await run.cleanup(); }
});

test("killing the writer during a rename retry preserves the last complete snapshot", async () => {
  const run = controlled({ failures: 1, pause: true });
  const lines = createInterface({ input: run.child.stdout });
  try {
    const messages: readonly unknown[] = await Promise.race([
      once(lines, "line", { signal: AbortSignal.timeout(10_000) }),
      run.closed.then(result => { throw new Error(`fixture exited before retry checkpoint: ${JSON.stringify(result)} ${run.stderr()}`); }),
    ]);
    assert.equal(messages[0], "state-rename-retry-paused");
    assert.ok(run.child.kill("SIGKILL"), "the writer must still be blocked before publication");
    await run.closed;
    expect(run.fake.read()).toEqual(initial);
    expect(run.records()).toEqual([{ kind: "refused", state: initial }, { kind: "wait", milliseconds: 25 }]);
  } finally { lines.close(); await run.cleanup(); }
});
