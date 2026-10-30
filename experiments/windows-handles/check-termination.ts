import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alive, numberField, parseObject, readObject, waitUntil, writeJson } from "#probe-support";

const [inputDirectory] = process.argv.slice(2);
assert.ok(inputDirectory !== undefined);
const directory = path.resolve(inputDirectory);
async function runCase(mode: "normal" | "unreturned"): Promise<void> {
  const outputDirectory = path.join(directory, mode);
  mkdirSync(outputDirectory, { recursive: true });
  const startedAt = Date.now();
  const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File",
    fileURLToPath(new URL("termination.ps1", import.meta.url)), "-Mode", mode, "-OutputDirectory", outputDirectory],
  { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  // eslint-disable-next-line promise/avoid-new -- Bridge process events and an independent deadline.
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Prototype failed to exit: ${mode}`)); }, 25_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal, elapsedMs: Date.now() - startedAt }); });
  });
  writeFileSync(path.join(outputDirectory, "helper.stdout.log"), stdout);
  writeFileSync(path.join(outputDirectory, "helper.stderr.log"), stderr);
  const target = readObject(path.join(outputDirectory, "child-ready.json"));
  assert.ok(target !== null, JSON.stringify({ result, stdout, stderr }));
  const targetPid = numberField(target, "pid");
  try {
    const records = readFileSync(path.join(outputDirectory, "termination.jsonl"), "utf8").trim().split("\n").map((line) => parseObject(line));
    assert.equal(result.code, 124, JSON.stringify({ result, stdout, stderr }));
    assert.equal(records[0]?.readyAndAlive, true);
    assert.equal(readFileSync(path.join(outputDirectory, "kill-entered.txt"), "utf8"), mode);
    const [, termination] = records;
    assert.ok(termination !== undefined);
    assert.equal(termination.kind, mode === "normal" ? "termination_returned" : "termination_unreturned");
    const elapsedMs = numberField(termination, "elapsedMs");
    assert.ok(elapsedMs < 12_000, JSON.stringify(records));
    if (mode === "unreturned") { assert.ok(elapsedMs >= 10_000, JSON.stringify(records)); }
    assert.equal(records.at(-1)?.exitCode, 124);
    // Kill returning does not promise that process exit has already been observed.
    if (mode === "normal") { await waitUntil(() => !alive(targetPid), 1000); }
    const targetAliveAfterHelper = alive(targetPid);
    // Do not mistake helper exit for a stopped target; the injected hang leaves it alive.
    assert.equal(targetAliveAfterHelper, mode === "unreturned");
    const report = { mode, result, targetAliveAfterHelper, records };
    writeJson(path.join(outputDirectory, "report.json"), report);
    console.log(JSON.stringify(report));
  } finally {
    writeJson(path.join(outputDirectory, "stop.json"), {});
    await waitUntil(() => !alive(targetPid), 5000);
    assert.equal(alive(targetPid), false, "The synthetic target must stop.");
  }
}

await runCase("normal");
await runCase("unreturned");
