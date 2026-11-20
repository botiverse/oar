import { alive, signalFixture, type ProcessIdentity } from "../../tests/fixtures/process-tree.js";
import { identifiedProcesses, type Row } from "./support/codex-process-count.js";
import { expect, test, vi } from "vitest";
import { claudeInstallation, defineRuntime, claudeRuntime, codexRuntime } from "../../packages/oar/src/index.js";

import { startClaudeAimock, startCodexAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { withProcessEnv } from "./support/asserts.js";

const claudeSession = claudeRuntime.session;
const codexInstallation = codexRuntime.installation;
const codexSession = codexRuntime.session;

/*
 * oar#210, with the real binaries: the runtime runs a tool command, cannot
 * answer (SIGSTOP), and is disposed. Its SIGTERM goes unanswered, the SIGKILL
 * ends it, and every process below it must go too, including the command,
 * which runs in a session of its own (claude 2.1.292's Bash tool, codex
 * 0.160.1's exec_command), out of the group the signals reach. Also an
 * upgrade probe: the command must still be found out of the runtime's group,
 * or what this pins (and the runtime pages say) has changed.
 */

function below(rows: readonly Row[], pid: number): Row[] {
  const found: Row[] = [];
  for (const child of rows.filter((row) => row.ppid === pid)) {
    found.push(child, ...below(rows, child.pid));
  }
  return found;
}

const COMMAND = "tail -f /dev/null";
const runtimes = [
  { id: "claude-aimock", session: claudeSession, installation: claudeInstallation, environment: startClaudeAimock, binary: /claude/u,
    tool: { name: "Bash", arguments: JSON.stringify({ command: COMMAND }) } },
  { id: "codex-aimock", session: codexSession, installation: codexInstallation, environment: startCodexAimock, binary: /codex/u,
    tool: { name: "exec_command", arguments: JSON.stringify({ cmd: COMMAND }) } },
] as const;

for (const runtime of runtimes) {
  test.skipIf(process.env.OAR_TEST !== runtime.id || process.platform === "win32")(
    `${runtime.id}: disposing a stuck runtime ends the tool command it runs out of its process group`,
    async () => {
      const env = await runtime.environment((mock) => {
        mock.on({ userMessage: /run the tool/u, hasToolResult: false }, { toolCalls: [runtime.tool] });
        mock.on({ hasToolResult: true }, { content: "done" });
      });
      const seen: (Row & ProcessIdentity)[] = [];
      const stopped: ProcessIdentity[] = [];
      try {
        await withProcessEnv({ OAR_KILL_GRACE_MS: "500" }, async () => {
          const session = await runtimeUnderTest(defineRuntime(runtime), env.env).startSession();
          try {
            await session.prompt("please run the tool");
            const command = await vi.waitFor(() => {
              const rows = identifiedProcesses(snapshot => {
                const root = snapshot.find(row => row.ppid === process.pid && runtime.binary.test(row.args));
                return root === undefined ? [] : [root, ...below(snapshot, root.pid)];
              });
              const host = rows.find(row => row.ppid === process.pid && runtime.binary.test(row.args));
              const tool = rows.find(row => row.args.startsWith(COMMAND));
              if (host === undefined || tool === undefined) { throw new Error("the tool command is not running yet"); }
              seen.splice(0, seen.length, ...rows);
              return { host, tool };
            }, { timeout: 60_000, interval: 200 });
            expect(command.tool.pgid, "the command runs out of the runtime's process group").not.toBe(command.host.pid);
            expect(signalFixture(command.host, "SIGSTOP"), "SIGSTOP reached the runtime").toBe(true);
            expect(alive(command.host), "the stopped runtime is still present").toBe(true);
            stopped.push(command.host);
          } finally {
            await session.dispose();
          }
          await vi.waitFor(() => {
            expect(seen.filter(row => alive(row)).map((row) => `${String(row.pid)} ${row.args}`)).toEqual([]);
          }, { timeout: 5000, interval: 100 });
        });
      } finally {
        for (const host of stopped) { signalFixture(host, "SIGCONT"); }
        for (const row of seen) {
          signalFixture(row);
        }
        await env.stop();
      }
    },
    120_000,
  );
}
