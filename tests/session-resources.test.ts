import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, test } from "vitest";
import type { Session, SessionOptions } from "../packages/oar/src/contracts/session.js";
import { claudeSession } from "../packages/oar/src/runtimes/claude/session.js";
import { codexSession } from "../packages/oar/src/runtimes/codex/session.js";
import { acpSession } from "../packages/oar/src/shared/acp/session.js";
import { processTreeResources } from "../packages/oar/src/shared/executable/process-resources.js";
import { fixture as acpAgent, profile } from "./fixtures/acp-session-support.js";
import { agentTreeModule, fakeAgentBinary, withTreeProbe } from "./fixtures/process-tree.js";

type Open = (dir: string, options: SessionOptions) => Promise<Session>;

// Every adapter that owns a runtime process, against a stand-in agent that
// started a tool of its own (fixtures/process-tree.ts), as session-dispose.test.ts.
const runtimes: readonly (readonly [string, Open])[] = [
  ["claude", async (dir, options) => claudeSession({ kind: "available", via: "executable", command: fakeAgentBinary(dir) }, options)],
  ["codex", async (dir, options) => codexSession({ kind: "available", via: "executable", command: fakeAgentBinary(dir) }, options)],
  ["acp", async (dir, options) => acpSession(profile({ args: [] }))(
    { kind: "available", via: "executable", command: fakeAgentBinary(dir, ["--import", agentTreeModule, acpAgent, "session"]) },
    options,
  )],
];

/** A process the size of a Node process: some megabytes resident. */
const NODE_RSS = 10 * 1024 * 1024;

describe.skipIf(process.platform === "win32")("Session.resources() counts the runtime and what it started (POSIX)", () => {
  const cases = runtimes.flatMap(([runtime, open]) => [false, true].map((detachTool) => [runtime, detachTool, open] as const));
  test.each(cases)("%s (its tool in a session of its own: %s)", async (_runtime, detachTool, open) => {
    await withTreeProbe({ ignoreSigterm: false, detachTool }, async (probe) => {
      const session = await open(probe.dir, { cwd: probe.dir, env: probe.env });
      await probe.tree();
      expect("resources" in session).toBe(true);
      const resources = await session.resources?.();
      // The agent and the tool it started, whether or not the tool left its group.
      expect(resources?.processes).toBe(2);
      expect(resources?.rss).toBeGreaterThan(2 * NODE_RSS);
      await session.dispose();
      expect(await session.resources?.()).toBeNull();
    });
  });
});

test.skipIf(process.platform === "win32").each(process.platform === "linux" ? ["linux", "darwin"] as const : ["darwin"] as const)(
  "the %s reader counts a process, its group and a descendant that left it",
  async (platform) => {
    // A leader with one child in its group and one in a session of its own.
    const leader = spawn(process.execPath, ["-e", String.raw`
      const { spawn } = require("node:child_process");
      const sleep = ["-e", "setTimeout(() => {}, 60000)"];
      const kept = spawn(process.execPath, sleep, { stdio: "ignore" });
      const left = spawn(process.execPath, sleep, { stdio: "ignore", detached: true });
      Promise.all([kept, left].map((child) => new Promise((resolve) => child.once("spawn", resolve)))).then(() => process.stdout.write(left.pid + "\n"));
      setTimeout(() => {}, 60000);
    `], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    const reported: unknown[] = await once(leader.stdout, "data");
    const left = Number(String(reported[0]));
    try {
      const resources = await processTreeResources(leader.pid ?? 0, platform);
      expect([resources?.processes, (resources?.rss ?? 0) > 3 * NODE_RSS]).toEqual([3, true]);
    } finally {
      process.kill(-(leader.pid ?? 0), "SIGKILL");
      process.kill(left, "SIGKILL");
    }
  },
);

test("a pid no longer running, and Windows, have no reading", async () => {
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(gone, "exit");
  expect(await processTreeResources(gone.pid ?? 0)).toBeNull();
  expect(await processTreeResources(process.pid, "win32")).toBeNull();
});
