/** Real ACP command priority probe, shared by manual inventory and vendor regression. */
/* oxlint-disable import/max-dependencies, eslint/max-statements, eslint/max-lines-per-function, unicorn/no-await-expression-member -- The native probe composes the same local providers used by CI. */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultRuntimes, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock } from "./aimock-acp.js";
import { startCodebuddyAimock } from "./codebuddy-aimock.js";

const factories = { grok: startGrokAimock, kimi: startKimiAimock, opencode: startOpencodeAimock, antigravity: startAntigravityAimock, codebuddy: startCodebuddyAimock };
type RuntimeId = keyof typeof factories;
const quote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

function terminalCall(id: RuntimeId, command: string, codeMode: boolean): { name: string; arguments: Record<string, unknown> } {
  if (id === "grok") { return { name: "run_terminal_command", arguments: { command, description: "Read command OOM score", block_until_ms: 30_000 } }; }
  if (id === "antigravity") { return { name: "run_command", arguments: { CommandLine: command, WaitMsBeforeAsync: 10_000, toolSummary: "Read priority" } }; }
  if (id === "opencode") { return { name: codeMode ? "shell" : "bash", arguments: { command, description: "Read command OOM score" } }; }
  return { name: "Bash", arguments: { command } };
}

/** Real agent, local scripted model, isolated configuration. No account or paid inference. */
export async function probeTerminalPriority(id: RuntimeId): Promise<{ runtime: RuntimeId; version: string | undefined; hostScore: number; agentScore: number; commandScore: number; completed: boolean; reverseRequests: string[] }> {
  assert.equal(process.platform, "linux");
  const home = await mkdtemp(path.join(tmpdir(), "oar-terminal-priority-"));
  const hostScore = Number((await readFile("/proc/self/oom_score_adj", "utf8")).trim());
  const agentScore = Math.max(500, hostScore + 1);
  assert.ok(agentScore <= 1000, "probe needs room to raise the native agent score");
  const toolScript = path.join(home, "read-score");
  const resultPath = path.join(home, "command.json");
  await writeFile(toolScript, `#!${process.execPath}\nconst fs=require('node:fs');const score=Number(fs.readFileSync('/proc/self/oom_score_adj','utf8'));fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({score}));console.log('ACP_PRIORITY='+score);`);
  await chmod(toolScript, 0o700);
  let rounds = 0;
  const provider = await factories[id]((mock) => {
    mock.on({ predicate: request => request.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("ACP_PRIORITY_PROBE")) }, (request) => {
      const toolNames = (request.tools ?? []).map(tool => tool.function.name);
      // Native title/summary requests also contain the prompt but cannot execute tools.
      if (rounds === 0 && toolNames.length === 0) { return { content: "metadata" }; }
      if (rounds++ === 0) {
        const command = toolScript;
        const call = terminalCall(id, command, toolNames.includes("execute"));
        return { toolCalls: [{ id: "priority-tool", name: call.name, arguments: JSON.stringify(call.arguments) }] };
      }
      return { content: "priority probe completed" };
    });
    mock.onMessage(/[\s\S]*/u, { content: "metadata" });
  });
  let session: Session | null = null;
  try {
    const runtime = defaultRuntimes.require(id);
    const installation = await runtime.installation?.();
    assert.ok(installation?.kind === "available" && installation.via === "executable", JSON.stringify(installation));
    const agentFile = path.join(home, "agent-pid");
    const wrapper = path.join(home, "agent-wrapper.sh");
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' ${String(agentScore)} > /proc/self/oom_score_adj || exit 1\nprintf '%s\\n' "$$" > ${quote(agentFile)}\nexec ${quote(installation.command)} "$@"\n`);
    await chmod(wrapper, 0o700);
    session = await runtime.session({ ...installation, command: wrapper }, { cwd: home, env: provider.env, ...(id === "codebuddy" ? { launchArgs: ["--model", "deepseek-flash"] } : {}) });
    const agentPid = Number((await readFile(agentFile, "utf8")).trim());
    const actualAgentScore = Number((await readFile(`/proc/${String(agentPid)}/oom_score_adj`, "utf8")).trim());
    const outcome = await promptAndWait(session, "ACP_PRIORITY_PROBE", { timeoutMs: 45_000 });
    const toolResult = asRecord(JSON.parse(await readFile(resultPath, "utf8")));
    assert.equal(actualAgentScore, agentScore);
    assert.ok(outcome.kind === "ended");
    assert.equal(outcome.outcome.kind, "completed");
    const commandScore = toolResult?.score;
    assert.ok(typeof commandScore === "number");
    assert.equal(Number(await readFile("/proc/self/oom_score_adj", "utf8")), hostScore);
    return { runtime: id, version: installation.version, hostScore, agentScore: actualAgentScore, commandScore, completed: true,
      reverseRequests: session.records().flatMap(record => record.kind === "request" && record.direction === "toApp" && record.body.kind === "native" ? [record.body.type] : []),
    };
  } finally {
    await session?.dispose();
    await provider.stop();
    await rm(home, { recursive: true, force: true });
  }
}
