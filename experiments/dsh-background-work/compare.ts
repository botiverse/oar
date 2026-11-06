/* oxlint-disable eslint/no-await-in-loop -- Serial native controls do not compete with each other for resources. */
/** Linux controls: a held shell or child finishes after its parent's first turn. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { awaitTurnEnd, claudeInstallation, claudeSession, codexInstallation, codexSession, tasksOf, type Session } from "../../packages/oar/src/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock } from "../../sea-trial/harness/aimock.js";
import { codexTaskRecipient, codexTaskRequest } from "../../sea-trial/vendor/support/codex-task-request.js";

function qualify(value: unknown): unknown {
  const item = asRecord(value);
  return item?.type === "function_call" && item.name === "spawn_agent" ? { ...item, namespace: "collaboration" } : value;
}
function qualifyResponse(body: string): string {
  return body.split("\n").map(line => {
    if (!line.startsWith("data: ")) { return line; }
    const event = asRecord(parseJson(line.slice(6))); if (event === null) { return line; }
    const response = asRecord(event.response);
    return `data: ${JSON.stringify({ ...event, ...("item" in event ? { item: qualify(event.item) } : {}), ...(Array.isArray(response?.output) ? { response: { ...response, output: response.output.map(qualify) } } : {}) })}`;
  }).join("\n");
}
const output = path.resolve(process.argv[2] ?? "oar-trial-run/background-compare");
await mkdir(output, { recursive: true });
for (const runtime of ["claude", "codex"] as const) {
  for (const kind of ["shell", "agent"] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), "oar-background-compare-"));
    const released = Promise.withResolvers<void>();
    let rootRequests = 0; let childRequests = 0;
    const provider = await (runtime === "claude" ? startClaudeAimock : startCodexAimock)(mock => {
      mock.on({ predicate: () => true }, async request => {
        const child = runtime === "codex" ? codexTaskRecipient(request) === "/root/child" : JSON.stringify(request.messages.findLast(message => message.role === "user")).includes("BACKGROUND_CHILD");
        if (child) { childRequests += 1; await released.promise; return { content: "CHILD_FINISHED" }; }
        rootRequests += 1;
        const completed = request.messages.some(message => message.role === "tool" && message.tool_call_id === "start-work");
        if (!completed) {
          const command = `while [ ! -f '${path.join(directory, "release")}' ]; do sleep 0.02; done; printf 'SHELL_FINISHED\\n'`;
          const tool = kind === "shell"
            ? { name: runtime === "claude" ? "Bash" : "exec_command", arguments: JSON.stringify(runtime === "claude" ? { command, description: "held shell", run_in_background: true } : { cmd: command, yield_time_ms: 1000 }) }
            : { name: runtime === "claude" ? "Agent" : "spawn_agent", arguments: JSON.stringify(runtime === "claude" ? { prompt: "BACKGROUND_CHILD", description: "held child", subagent_type: "general-purpose", run_in_background: true } : { task_name: "child", message: "BACKGROUND_CHILD", fork_turns: "none" }) };
          return { toolCalls: [{ id: "start-work", ...tool }] };
        }
        return { content: "ROOT_FINISHED" };
      });
    }, runtime === "codex" ? { captureRaw: true, rewriteRequest: codexTaskRequest, rewriteResponse: qualifyResponse } : { captureRaw: true });
    let session: Session | null = null;
    try {
      const installation = await (runtime === "claude" ? claudeInstallation : codexInstallation)();
      assert.ok(installation.kind === "available" && installation.via === "executable");
      session = await (runtime === "claude" ? claudeSession : codexSession)(installation, { cwd: directory, env: { ...provider.env },
        model: runtime === "claude" ? "haiku" : "gpt-6.1-sol", ...(runtime === "claude" ? { userConfiguration: "exclude" as const } : {}),
        ...(runtime === "codex" ? { launchArgs: ["-c", "features.multi_agent=true", "-c", "features.multi_agent_v2=true"] } : {}) });
      const started = await session.prompt("BACKGROUND_ROOT", { inputId: "00000000-0000-4000-8000-000000000197" });
      assert.deepEqual(await awaitTurnEnd(session, started.seq), { kind: "completed" });
      const first = { status: session.status().value, tasks: tasksOf(session.records()).value, records: session.records().length };
      await writeFile(path.join(directory, "release"), "release"); released.resolve();
      // A bounded observation, not a claim that no future native wake can occur.
      await delay(5000);
      const rootEnds = session.records().filter(record => record.kind === "frame" && record.sessionId === session?.id && record.agentPath.length === 0 && record.body.events.some(event => event.kind === "turn_ended")).length;
      const summary = { runtime, kind, version: installation.version, first, afterFiveSeconds: { status: session.status().value, tasks: tasksOf(session.records()).value, rootEnds }, rootRequests, childRequests };
      await writeFile(path.join(output, `${runtime}-${kind}.json`), JSON.stringify({ summary, records: session.records(), requests: provider.raw }, null, 2));
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } finally {
      released.resolve(); await writeFile(path.join(directory, "release"), "release");
      await session?.dispose(); await provider.stop();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}
