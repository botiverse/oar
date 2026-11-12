import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { expect, test } from "vitest";
import { expectRunning } from "./support/codex-process-count.js";

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
