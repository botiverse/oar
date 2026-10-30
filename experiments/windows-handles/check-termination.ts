import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { alive, numberField, parseObject, readObject, waitUntil, writeJson } from "#probe-support";

interface ProcessEvent {
  readonly kind: "exit" | "close";
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly at: number;
  readonly elapsedMs: number;
}

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
  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString(); appendFileSync(path.join(outputDirectory, "helper.stdout.log"), data);
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString(); appendFileSync(path.join(outputDirectory, "helper.stderr.log"), data);
  });
  const exited = Promise.withResolvers<ProcessEvent>();
  const events: ProcessEvent[] = [];
  const state: { exit: ProcessEvent | null; close: ProcessEvent | null } = { exit: null, close: null };
  function observe(kind: "exit" | "close", code: number | null, signal: NodeJS.Signals | null): ProcessEvent {
    const event = { kind, code, signal, at: Date.now(), elapsedMs: Date.now() - startedAt };
    events.push(event);
    appendFileSync(path.join(outputDirectory, "process-events.jsonl"), `${JSON.stringify(event)}\n`);
    console.log(JSON.stringify({ mode, ...event }));
    return event;
  }
  child.once("exit", (code, signal) => { state.exit = observe("exit", code, signal); exited.resolve(state.exit); });
  child.once("close", (code, signal) => { state.close = observe("close", code, signal); });
  child.once("error", (error) => { exited.reject(error); });
  const timeout = setTimeout(() => { exited.reject(new Error(`Prototype root failed to exit: ${mode}`)); }, 25_000);
  try {
    const result = await exited.promise;
    clearTimeout(timeout);
    const target = readObject(path.join(outputDirectory, "child-ready.json"));
    assert.ok(target !== null, JSON.stringify({ result, stdout, stderr }));
    const targetPid = numberField(target, "pid");
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
    const final = records.at(-1);
    assert.ok(final !== undefined);
    assert.equal(final.exitCode, 124);
    // Independently prove root exit soon after the final checkpoint, before any target cleanup.
    assert.ok(result.at - numberField(final, "at") < 2000, JSON.stringify({ result, records }));
    if (mode === "normal") { await waitUntil(() => !alive(targetPid), 1000); }
    const targetAliveAfterHelper = alive(targetPid);
    assert.equal(targetAliveAfterHelper, mode === "unreturned");
    // Stream closure is an observation, separate from the root-exit deadline.
    await waitUntil(() => state.close !== null, 1000);
    const report = { mode, result, targetAliveAfterHelper, pipesClosedBeforeTargetCleanup: state.close !== null, records };
    writeJson(path.join(outputDirectory, "report.json"), report);
    console.log(JSON.stringify(report));
  } finally {
    clearTimeout(timeout);
    writeJson(path.join(outputDirectory, "stop.json"), {});
    const target = readObject(path.join(outputDirectory, "child-ready.json"));
    if (target !== null) {
      const targetPid = numberField(target, "pid");
      await waitUntil(() => !alive(targetPid), 5000);
      assert.equal(alive(targetPid), false, "The synthetic target must stop.");
    }
    if (state.exit === null) { child.kill(); }
    await waitUntil(() => state.close !== null, 5000);
    writeJson(path.join(outputDirectory, "cleanup.json"), { events, pipesClosedAfterCleanup: state.close !== null });
    // A failing probe must not wait indefinitely on its collector's inherited pipes.
    child.stdout.destroy(); child.stderr.destroy();
    assert.ok(state.close !== null, "The output pipes must close after target cleanup.");
  }
}

await runCase("normal");
await runCase("unreturned");
