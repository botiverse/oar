/* oxlint-disable import/max-dependencies -- These regressions join real children, files and the process table. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { expectRunning, expectStarted, processTable } from "./support/codex-process-count.js";

// No runtime needed: exercise a failing count, including BSD/GNU ps formatting and long commands.
test.skipIf(process.platform === "win32")("process-count failures retain only matching process details", async () => {
  const marker = `oar-count-proof-${randomUUID()}`;
  const unrelated = `oar-count-other-${randomUUID()}`;
  const suffix = `${"a".repeat(1024)}-command-end`;
  const children = [marker, marker, unrelated].map((name) => spawn(process.execPath,
    ["-e", "setInterval(() => {}, 1000)", name, suffix], { stdio: "ignore" }));
  try {
    await Promise.all(children.map(async (child) => once(child, "spawn")));
    let message = "";
    try { expectRunning(marker).toHaveLength(1); } catch (error) { message = String(error); }
    expect(message).toContain("to have a length of 1 but got 2");
    for (const child of children.slice(0, 2)) {
      expect(message).toContain(`"pid": ${child.pid}`);
    }
    expect(message).toContain(`"ppid": ${process.pid}`);
    expect(message).toMatch(/"startedAt": "\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}"/u);
    expect(message).toContain(marker);
    expect(message).toContain(`${suffix}"`);
    expect(message).not.toContain(unrelated);
  } finally {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) { return; }
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }));
  }
});

test.skipIf(process.platform === "win32")("fixture readiness distinguishes shell startup from duplicate commands", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-count-startup-"));
  const marker = `oar-count-startup-${randomUUID()}`;
  const gate = path.join(directory, "release");
  const started = path.join(directory, "started");
  const code = String.raw`require("node:fs").appendFileSync(process.argv[1], String(process.pid) + "\n"); setInterval(() => {}, 1000)`;
  const waits = `(while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.05; done) & `.repeat(3);
  const command = `${waits}wait; exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} ${JSON.stringify(started)} ${marker}`;
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], { stdio: "ignore", detached: true });
  try {
    await once(child, "spawn");
    await vi.waitFor(() => { expectRunning(marker).toHaveLength(4); }, { timeout: 5000, interval: 25 });
    // The previous assertion fails even though no copy of the Node fixture has started.
    expect(() => { expectRunning(marker).toHaveLength(1); }).toThrow("to have a length of 1 but got 4");
    await expect(readFile(started, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(gate, "");
    await expectStarted(started);
    expectRunning(marker).toHaveLength(1);
    expect(processTable().filter(row => row.args.includes(marker)).map(row => row.pid)).toEqual([child.pid]);
  } finally {
    // Reclaim matching shells too if the test failed before the fixture started.
    await writeFile(gate, "");
    const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : null;
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* The owned group is already gone. */ }
    }
    if (exited !== null) { await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
