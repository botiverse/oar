// Synthetic, finite-lived descendants only. This probe uses no runtime or account.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { alive, numberField, readObject, waitUntil, writeJson } from "#probe-support";

const [mode, directory] = process.argv.slice(2);
assert.ok(directory !== undefined);
mkdirSync(directory, { recursive: true });
const filename = (name: string): string => path.join(directory, `${name}.json`);
const write = (name: string, value: unknown): void => { writeJson(filename(name), value); };
const read = (name: string): Record<string, unknown> | null => readObject(filename(name));

if (mode === "child") {
  const startedAt = Date.now();
  write("child-ready", { pid: process.pid, parentPid: process.ppid, startedAt });
  process.stdout.write("synthetic child ready\n");
  process.stderr.write("synthetic child stderr\n");
  while (!existsSync(filename("stop")) && Date.now() - startedAt < 45_000) {
    write("heartbeat", { pid: process.pid, at: Date.now() });
    // eslint-disable-next-line no-await-in-loop -- A finite heartbeat must remain sequential.
    await delay(100);
  }
  write("child-exited", { pid: process.pid, at: Date.now() });
} else if (mode === "inherited" || mode === "file") {
  const handles = mode === "file"
    ? [openSync(path.join(directory, "child.stdout.log"), "w"), openSync(path.join(directory, "child.stderr.log"), "w")]
    : [];
  const child = spawn(process.execPath, [import.meta.filename, "child", directory], {
    detached: true,
    stdio: ["ignore", handles[0] ?? "inherit", handles[1] ?? "inherit"],
  });
  child.on("error", (error) => { throw error; });
  child.unref();
  for (const handle of handles) { closeSync(handle); }
  await waitUntil(() => read("child-ready") !== null, 10_000);
  const ready = read("child-ready");
  assert.ok(child.pid !== undefined, "The descendant must have started.");
  assert.equal(ready?.pid, child.pid, "The descendant must be ready before its parent exits.");
  assert.equal(alive(child.pid), true, "The descendant must still be alive.");
  write("parent-exiting", { mode, pid: process.pid, childPid: child.pid, at: Date.now() });
  process.stdout.write(`synthetic parent exiting (${mode})\n`);
} else if (mode === "observe") {
  const observedAt = Date.now();
  const wrapper = read("wrapper-exiting");
  const ready = read("child-ready");
  assert.ok(wrapper !== null, "The preceding step must record its final boundary.");
  assert.ok(ready !== null, "The child readiness record must exist.");
  const childPid = numberField(ready, "pid");
  const observation = {
    observedAt,
    wrapper,
    child: ready,
    childAliveAtNextStep: alive(childPid),
    lastHeartbeat: read("heartbeat"),
    nextStepDelayMs: observedAt - numberField(wrapper, "at"),
  };
  write("observation", observation);
  console.log(JSON.stringify(observation));
  // A scoped control file lets the owned fixture stop without signalling a reused PID.
  write("stop", { at: Date.now() });
  await waitUntil(() => !alive(childPid), 5000);
  assert.equal(alive(childPid), false, "The finite child must honor its stop file or already be gone.");
  write("cleanup", { childGone: true, at: Date.now() });
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}
