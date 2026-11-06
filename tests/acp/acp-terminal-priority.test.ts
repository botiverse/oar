/* oxlint-disable eslint/max-statements, eslint/max-params, unicorn/no-await-expression-member, unicorn/max-nested-calls -- Process-lifetime tests keep launch, readback and cleanup together. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { eventually, gone } from "../fixtures/process-tree.js";
import { createAcpTerminalHost, type AcpTerminalHost } from "../../packages/oar/src/shared/acp/terminal.js";

const scoreSource = "Number(require('node:fs').readFileSync('/proc/self/oom_score_adj','utf8'))";
async function commandOutput(host: AcpTerminalHost, command: string, args?: string[], env?: { name: string; value: string }[]): Promise<string> {
  const { terminalId } = await host.create({ sessionId: "score", command, ...(args === undefined ? {} : { args }), ...(env === undefined ? {} : { env }) });
  const identity = { sessionId: "score", terminalId };
  assert.deepEqual(await host.waitForExit(identity), { exitCode: 0, signal: null });
  const { output } = host.output(identity);
  await host.release(identity);
  return output;
}

async function withAgent(run: (pid: number, score: number, cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "oar-terminal-score "));
  const inherited = Number(await readFile("/proc/self/oom_score_adj", "utf8"));
  const score = Math.max(500, inherited + 1);
  assert.ok(score <= 1000, "test needs an inherited score below 1000");
  const agent = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync('/proc/self/oom_score_adj',process.argv[1]);console.log('ready');setInterval(()=>{},1000)", String(score)], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(agent, "close");
  try {
    await once(agent.stdout, "data");
    assert.ok(agent.pid !== undefined);
    assert.equal(Number(await readFile(`/proc/${String(agent.pid)}/oom_score_adj`, "utf8")), score);
    await run(agent.pid, score, cwd);
    assert.equal(Number(await readFile("/proc/self/oom_score_adj", "utf8")), inherited, "host priority stays unchanged");
  } finally { agent.kill("SIGKILL"); await exited; await rm(cwd, { recursive: true, force: true }); }
}

test.skipIf(process.platform !== "linux")("ACP terminal takes the agent score before argv, cwd, environment and descendant execution", async () => {
  await withAgent(async (pid, score, cwd) => {
    const host = createAcpTerminalHost(cwd, process.env, { agentPid: () => pid });
    const argument = "spaces ' quotes $(touch not-created) ; $HOME";
    try {
      const output = await commandOutput(host, process.execPath, ["-e", `console.log(JSON.stringify({score:${scoreSource},cwd:process.cwd(),arg:process.argv[1],env:process.env.ACP_VALUE,child:Number(require('node:child_process').execFileSync(process.execPath,['-e',${JSON.stringify(`console.log(${scoreSource})`)}]))}))`, argument], [{ name: "ACP_VALUE", value: argument }]);
      assert.deepEqual(JSON.parse(output), { score, cwd, arg: argument, env: argument, child: score });
    } finally { await host.dispose(); }
  });
});

test.skipIf(process.platform !== "linux")("ACP terminal preserves full shell commands and reads the current agent for each command", async () => {
  await withAgent(async (pid, score, cwd) => {
    let currentPid = pid;
    const host = createAcpTerminalHost(cwd, process.env, { agentPid: () => currentPid, shellCommand: true });
    try {
      assert.equal((await commandOutput(host, "cat /proc/self/oom_score_adj; printf ':shell'")).trim(), `${String(score)}\n:shell`);
      await writeFile(`/proc/${String(pid)}/oom_score_adj`, String(score + 1));
      assert.equal((await commandOutput(host, "cat /proc/self/oom_score_adj")).trim(), String(score + 1));
      currentPid = process.pid;
      assert.equal((await commandOutput(host, "cat /proc/self/oom_score_adj")).trim(), (await readFile("/proc/self/oom_score_adj", "utf8")).trim());
    } finally { await host.dispose(); }
  });
});

test.skipIf(process.platform !== "linux")("an unreadable native process keeps the host score and original launch behavior", async () => {
  const host = createAcpTerminalHost(process.cwd(), process.env, { agentPid: () => 2_147_483_647 });
  try {
    assert.equal((await commandOutput(host, process.execPath, ["-e", `console.log(${scoreSource})`])).trim(), (await readFile("/proc/self/oom_score_adj", "utf8")).trim());
  } finally { await host.dispose(); }
});

test.skipIf(process.platform !== "linux")("equal native and host priorities spawn the original command with its original argv zero", async () => {
  const command = path.basename(process.execPath);
  const host = createAcpTerminalHost(process.cwd(), { ...process.env, PATH: path.dirname(process.execPath) }, { agentPid: () => process.pid });
  try {
    assert.equal((await commandOutput(host, command, ["-e", "console.log(process.argv0)"])).trim(), command);
  } finally { await host.dispose(); }
});

test.skipIf(process.platform !== "linux")("priority forwarding resolves relative PATH in the terminal cwd and preserves missing-command rejection", async () => {
  await withAgent(async (pid, score, cwd) => {
    const executable = path.join(cwd, "score-command");
    await writeFile(executable, "#!/bin/sh\ncat /proc/self/oom_score_adj\n");
    await chmod(executable, 0o700);
    const host = createAcpTerminalHost(cwd, { ...process.env, PATH: `.:${process.env.PATH ?? "/usr/bin:/bin"}` }, { agentPid: () => pid });
    try {
      assert.equal((await commandOutput(host, "score-command", [])).trim(), String(score));
      await assert.rejects(host.create({ sessionId: "score", command: "oar-missing-terminal-command", args: [] }), /ENOENT/u);
    } finally { await host.dispose(); }
  });
});

// The added exec wrapper must stay in the process group the host owns.
test.skipIf(process.platform !== "linux")("releasing a priority-adjusted terminal kills its descendants", async () => {
  await withAgent(async (pid, _score, cwd) => {
    const host = createAcpTerminalHost(cwd, process.env, { agentPid: () => pid, shellCommand: true });
    try {
      const { terminalId } = await host.create({ sessionId: "tree", command: "sleep 60 & echo $!; wait" });
      const identity = { sessionId: "tree", terminalId };
      assert.ok(await eventually(() => /^\d+/u.test(host.output(identity).output), 5000));
      const descendant = Number(host.output(identity).output.trim());
      await host.release(identity);
      assert.equal(await gone(descendant), true);
    } finally { await host.dispose(); }
  });
});

test.skipIf(process.platform !== "linux")("a refused priority write still runs the terminal at its inherited score", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", path.resolve("tests/fixtures/acp-terminal-denied-priority.ts"), String(process.pid)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exit: unknown[] = await once(child, "close");
  assert.equal(exit[0], 0, stderr);
  assert.equal(stderr, "");
  const result = asRecord(JSON.parse(output));
  assert.ok(result !== null);
  assert.equal(result.score, result.expected);
  assert.deepEqual(result.exit, { exitCode: 0, signal: null });
});
