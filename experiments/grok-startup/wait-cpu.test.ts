/* oxlint-disable import/max-dependencies -- Real-process sampler control uses builtin process, file and timing APIs. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

test("Windows sampler records real busy CPU and rejects the same PID with an impossible start identity", { skip: process.platform !== "win32", timeout: 80_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "grok-cpu-test-"));
  const control = path.join(directory, "control.json");
  writeFileSync(control, JSON.stringify({ roots: [], stop: false }));
  const sampler = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("wait-cpu.ps1", import.meta.url)), "-ControlFile", control], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const ready = Promise.withResolvers<void>();
  const rows: Record<string, unknown>[] = [];
  const lines = createInterface({ input: sampler.stdout });
  lines.on("line", text => { const row = asRecord(parseJson(text)); if (row !== null) { rows.push(row); if (row.phase === "sampler_ready") { ready.resolve(); } } });
  const closed = once(sampler, "close");
  sampler.stderr.resume();
  const timeout = setTimeout(() => { ready.reject(new Error("sampler not ready")); }, 60_000);
  try {
    await ready.promise;
    const earliest = Date.now();
    const child = spawn(process.execPath, ["-e", "const until=Date.now()+5000; while(Date.now()<until){}; setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
    const ended = once(child, "close");
    assert.ok(child.pid !== undefined);
    writeFileSync(control, JSON.stringify({ stop: false, roots: [
      { ordinal: 1, pid: child.pid, earliest, latest: Date.now() },
      { ordinal: 2, pid: child.pid, earliest: 0, latest: 1 },
    ] }));
    try {
      await delay(8000);
      const good = rows.filter(row => row.phase === "cpu_sample" && row.ordinal === 1);
      const wrong = rows.filter(row => row.phase === "cpu_sample" && row.ordinal === 2);
      assert.ok(good.some(row => typeof row.cpuMs === "number" && row.cpuMs > 100), "Busy real process must contribute CPU time");
      assert.ok(wrong.length > 0, "Wrong-identity control must actually be sampled");
      assert.ok(wrong.every(row => row.observedProcesses === 0 && row.cpuMs === 0), "A recycled PID is not the original process");
      assert.ok(good.every(row => typeof row.queryMs === "number" && row.queryMs >= 0));
      assert.ok(!rows.some(row => row.phase === "sampler_error"));
    } finally { child.kill(); await ended; }
  } finally {
    clearTimeout(timeout);
    writeFileSync(control, JSON.stringify({ stop: true, roots: [] }));
    const stop = setTimeout(() => { sampler.kill(); }, 5000);
    await closed;
    clearTimeout(stop); lines.close(); rmSync(directory, { recursive: true, force: true });
  }
});
