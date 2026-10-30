import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { cwdEvidence, powershellCommand, prepareFixture, ProbeTiming } from "../experiments/sharing/observation.js";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

// oxlint-disable-next-line max-statements -- Check aliases and cross-session rejection using the same native directories.
test("cwd evidence accepts a filesystem alias but rejects a different session directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-sharing-paths-"));
  const actual = path.join(directory, "a");
  const other = path.join(directory, "b");
  const alias = path.join(directory, "alias");
  try {
    await Promise.all([mkdir(actual), mkdir(other)]);
    await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const evidence = cwdEvidence(alias, [{ output: JSON.stringify({ stdout: `CWD_RESULT=${actual}\n` }) }]);
    expect(evidence.expectedRaw).toBe(alias);
    expect(evidence.observed).toEqual([{ raw: actual, canonical: evidence.expectedCanonical }]);
    expect(() => cwdEvidence(alias, `CWD_RESULT=${other}\n`)).toThrow("tool ran in its own canonical directory");
    expect(() => cwdEvidence(alias, `CWD_RESULT=${actual}\nCWD_RESULT=${other}\n`)).toThrow("tool ran in its own canonical directory");
    expect(() => cwdEvidence(alias, "ParserError: command did not execute")).toThrow("tool output contains a cwd marker");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed setup persists its bounded wait and error before any native fixture exists", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-sharing-waits-"));
  const timing = new ProbeTiming();
  const never = Promise.withResolvers<void>();
  try {
    await expect(prepareFixture(directory, { waits: timing.waits }, async () => { await timing.wait(never.promise, "initialize", 20); })).rejects.toThrow("Timed out: initialize");
    const contents = await readFile(path.join(directory, "evidence.json"), "utf8");
    expect(asRecord(JSON.parse(contents))).toEqual({ setupError: "Error: Timed out: initialize", waits: timing.waits });
    expect(timing.waits[0]).toMatchObject({ label: "initialize", limitMs: 20, outcome: "failed", error: "Error: Timed out: initialize" });
    expect(timing.waits[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "win32")("PowerShell invokes a quoted fixture path and preserves literal arguments", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar sharing's shell-"));
  const script = path.join(directory, "print args.cjs");
  const argument = "a 'quote' $env:PATH & literal";
  try {
    await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const result = await runExecutable("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", powershellCommand([process.execPath, script, argument])], { timeoutMs: 20_000 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual([argument]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
