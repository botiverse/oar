import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

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
    expect(records.filter((record) => record?.kind === "sample_error")).toEqual([]);
    expect(contents).not.toContain("synthetic-must-not-enter-samples");
    expect(contents).not.toContain(command);
    expect(contents).not.toMatch(/CommandLine|ExecutablePath|OAR_RESOURCE_SECRET/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 45_000);
