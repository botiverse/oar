import { execFileSync } from "node:child_process";
import { expect, test, vi } from "vitest";
import { claudeInstallation, claudeSession, codexInstallation, codexSession, defineRuntime } from "../../packages/oar/src/index.js";
import { startClaudeAimock, startCodexAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { withProcessEnv } from "./support/asserts.js";

/*
 * oar#210, with the real binaries: the runtime runs a tool command, cannot
 * answer (SIGSTOP), and is disposed. Its SIGTERM goes unanswered, the SIGKILL
 * ends it, and every process below it must go too, including the command,
 * which runs in a session of its own (claude 2.1.292's Bash tool, codex
 * 0.160.1's exec_command), out of the group the signals reach. Also an
 * upgrade probe: the command must still be found out of the runtime's group,
 * or what this pins (and the runtime pages say) has changed.
 */

interface Row { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly args: string }

function processes(): Row[] {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,args="], { encoding: "utf8" }).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), args: match[4] ?? "" }];
  });
}

function below(rows: readonly Row[], pid: number): Row[] {
  const found: Row[] = [];
  for (const child of rows.filter((row) => row.ppid === pid)) {
    found.push(child, ...below(rows, child.pid));
  }
  return found;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      const seen: Row[] = [];
      const stopped: number[] = [];
      try {
        await withProcessEnv({ OAR_KILL_GRACE_MS: "500" }, async () => {
          const session = await runtimeUnderTest(defineRuntime(runtime), env.env).startSession();
          try {
            await session.prompt("please run the tool");
            const command = await vi.waitFor(() => {
              const rows = processes();
              const host = rows.find((row) => row.ppid === process.pid && runtime.binary.test(row.args));
              const tool = host === undefined ? undefined : below(rows, host.pid).find((row) => row.args.startsWith(COMMAND));
              if (host === undefined || tool === undefined) { throw new Error("the tool command is not running yet"); }
              seen.splice(0, seen.length, host, ...below(rows, host.pid));
              return { host, tool };
            }, { timeout: 60_000, interval: 200 });
            expect(command.tool.pgid, "the command runs out of the runtime's process group").not.toBe(command.host.pid);
            process.kill(command.host.pid, "SIGSTOP");
            stopped.push(command.host.pid);
          } finally {
            await session.dispose();
          }
          await vi.waitFor(() => {
            expect(seen.filter((row) => alive(row.pid)).map((row) => `${String(row.pid)} ${row.args}`)).toEqual([]);
          }, { timeout: 5000, interval: 100 });
        });
      } finally {
        for (const pid of stopped.filter((stoppedPid) => alive(stoppedPid))) { process.kill(pid, "SIGCONT"); }
        for (const row of seen) {
          if (alive(row.pid)) { process.kill(row.pid, "SIGKILL"); }
        }
        await env.stop();
      }
    },
    120_000,
  );
}
