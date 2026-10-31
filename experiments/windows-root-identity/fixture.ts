import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { clock, waitFor, write } from "#identity-support";

const [mode, directory] = process.argv.slice(2);
assert.ok(directory !== undefined);
mkdirSync(directory, { recursive: true });
const file = (name: string): string => join(directory, `${name}.json`);

if (mode === "immediate") {
  process.exit(7);
} else if (mode === "tool") {
  write(file("tool-ready"), { pid: process.pid, parentPid: process.ppid, clock: clock() });
  const until = performance.now() + 45_000;
  while (!existsSync(file("stop-tool")) && performance.now() < until) {
    // eslint-disable-next-line no-await-in-loop -- A fixture-owned file stops this finite-lived tool, never a PID signal.
    await delay(50);
  }
  write(file("tool-finished"), { pid: process.pid, clock: clock() });
} else {
  assert.ok(mode === "normal" || mode === "orphan");
  const deadline = setTimeout(() => process.exit(124), 20_000);
  let toolPid: number | null = null;
  if (mode === "orphan") {
    const tool = spawn(process.execPath, [import.meta.filename, "tool", directory], { detached: true, stdio: "ignore" });
    tool.on("error", (error) => { throw error; });
    tool.unref();
    assert.ok(tool.pid !== undefined);
    toolPid = tool.pid;
    await waitFor(file("tool-ready"), 8000);
  }
  write(file("root-ready"), { pid: process.pid, toolPid, clock: clock() });
  process.stdin.once("data", () => {
    clearTimeout(deadline);
    process.exit(0);
  });
  process.stdin.resume();
}
