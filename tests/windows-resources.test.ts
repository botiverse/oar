import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

function expectHandleCounts(sample: Record<string, unknown>): void {
  const processes = Array.isArray(sample.processes) ? sample.processes.map(asRecord) : [];
  expect(processes.length).toBeGreaterThan(0);
  const counts = processes.map((process) => process?.handleCount);
  for (const count of counts) {
    if (count !== null) {
      expect(Number.isSafeInteger(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(0);
    }
  }
  // Unavailable CIM data stays visible instead of making the total look smaller.
  const total = counts.includes(null) ? null : counts.reduce<number>((sum, count) => sum + Number(count), 0);
  expect(sample.handleCount).toBe(total);
}

// oxlint-disable-next-line max-statements -- Verify native exit status, inherited output and persisted samples together.
test.skipIf(process.platform !== "win32").each([0, 37])("Windows sampler retains native exit %s and omits commands and environment", async (exitCode) => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-resource-sampler-"));
  const script = path.resolve("sea-trial/windows-resources.ps1");
  const command = `& '${process.execPath.replaceAll("'", "''")}' -e 'process.stdout.write("resource-stdout"); process.stderr.write("resource-stderr"); setTimeout(() => process.exit(${exitCode}), 2000)'`;
  try {
    const result = await runExecutable("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", script,
      "-Stage", "fixture", "-Command", command, "-OutputDirectory", directory, "-IntervalMs", "1000"], {
      timeoutMs: 30_000, env: { ...process.env, OAR_RESOURCE_SECRET: "synthetic-must-not-enter-samples" },
    });
    // runExecutable represents a successful native exit with ok=true and exitCode=null.
    expect({ code: result.exitCode, ok: result.ok }).toEqual({ code: exitCode === 0 ? null : exitCode, ok: exitCode === 0 });
    expect(result.stdout).toContain("resource-stdout");
    expect(result.stderr).toContain("resource-stderr");
    const contents = await readFile(path.join(directory, "fixture.jsonl"), "utf8");
    const records = contents.trim().split("\n").map((line) => asRecord(JSON.parse(line)));
    expect(records[0]?.kind).toBe("stage_start");
    expect(records.at(-1)).toMatchObject({ kind: "stage_exit", exitCode });
    expect(records.filter((record) => record?.kind === "sample").length).toBeGreaterThanOrEqual(3);
    for (const record of records) {
      if (record?.kind === "sample") { expectHandleCounts(record); }
    }
    expect(result.stdout).toMatch(/resources stage=fixture .* handles=(?:\d+|unknown) queryMs=\d+/u);
    expect(records.filter((record) => record?.kind === "sample_error")).toEqual([]);
    expect(contents).not.toContain("synthetic-must-not-enter-samples");
    expect(contents).not.toContain(command);
    expect(contents).not.toMatch(/CommandLine|ExecutablePath|OAR_RESOURCE_SECRET/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 45_000);

// oxlint-disable-next-line max-statements -- Verify the deadline, termination boundaries and both evidence sinks together.
test.skipIf(process.platform !== "win32")("the Windows command deadline logs termination before and after Kill", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-command-watchdog-"));
  try {
    const result = await runExecutable("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", path.resolve("sea-trial/windows-resources.ps1"),
      "-Stage", "deadline", "-Command", "Start-Sleep -Seconds 60", "-OutputDirectory", directory,
      "-CommandTimeoutSeconds", "2", "-IntervalMs", "1000"], { timeoutMs: 30_000 });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(124);
    const contents = await readFile(path.join(directory, "deadline.jsonl"), "utf8");
    const records = contents.trim().split("\n").map((line) => asRecord(JSON.parse(line)));
    const pid = records.find((record) => record?.kind === "command_start")?.pid;
    expect(pid).toEqual(expect.any(Number));
    const checkpoints = records.filter((record) => record?.kind === "command_timeout" || String(record?.kind).startsWith("termination_"));
    expect(checkpoints).toEqual([
      expect.objectContaining({ kind: "command_timeout", timeoutSeconds: 2 }),
      expect.objectContaining({ kind: "termination_start", pid }),
      expect.objectContaining({ kind: "termination_returned", pid }),
      expect.objectContaining({ kind: "termination_wait_returned", pid, rootExited: true, timeoutMs: 5000 }),
    ]);
    expect(checkpoints[2]?.elapsedMs).toEqual(expect.any(Number));
    const logged = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith("resources {")).map((line) => asRecord(JSON.parse(line.slice("resources ".length))));
    expect(logged).toEqual([...checkpoints, expect.objectContaining({ kind: "stage_exit", pid, exitCode: 124 })]);
    expect(records.at(-1)).toMatchObject({ kind: "stage_exit", exitCode: 124 });
    expect(contents).not.toContain("Start-Sleep");
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 45_000);
