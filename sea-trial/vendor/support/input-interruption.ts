import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { awaitTurnEnd, defaultRuntimes, viewOf, type ControlResult, type ConversationInput, type RawEvent, type ResponseBody, type TurnOutcome } from "../../../packages/oar/src/index.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, type LLMock } from "../../harness/aimock.js";
import { startGrokAimock, startOpencodeAimock } from "../../harness/aimock-acp.js";

const setups = { codex: startCodexAimock, claude: startClaudeAimock, pi: startPiAimock, grok: startGrokAimock, opencode: startOpencodeAimock };
const models = { codex: "gpt-5.1", claude: "haiku", pi: "aimock/aimock-model", grok: "aimock-model", opencode: "aimock/aimock-model" };
const tools = { codex: "exec_command", claude: "Bash", pi: "bash", grok: "run_terminal_command", opencode: "bash" };
interface InterruptionReport {
  readonly id: string;
  readonly version: string | undefined;
  readonly answers: readonly ResponseBody[];
  readonly outcome: TurnOutcome;
  readonly nextOutcome: TurnOutcome;
  readonly input: ConversationInput | undefined;
  readonly pending: readonly (string | undefined)[];
  readonly provider: readonly { afterNextPrompt: boolean; hasMarker: boolean }[];
  readonly records: readonly RawEvent[];
}
export async function interruptedInputProbe(id: keyof typeof setups, afterRead = false): Promise<InterruptionReport> {
  const marker = "unread-steer-marker-236";
  const inputId = "11111111-2222-4333-8444-555555555555";
  let calls = 0;
  const configure = (mock: LLMock): void => {
    mock.onMessage(/[\s\S]*/u, () => {
      calls += 1;
      const command = 'node -e "setTimeout(()=>console.log(123),30000)"';
      return calls === 1 ? { toolCalls: [{ name: tools[id], arguments: JSON.stringify(id === "codex" ? { cmd: command, yield_time_ms: 10_000 } : { command, description: "wait for interrupt" }) }] } : { content: "done" };
    }, { latency: 200 });
  };
  const env = id === "grok" || id === "opencode" ? await setups[id](configure) : await setups[id](configure, { captureRaw: true });
  const cwd = await mkdtemp(path.join(tmpdir(), `oar-interrupted-${id}-`));
  try {
    const runtime = defaultRuntimes.require(id);
    const installation = await runtime.installation?.();
    assert.ok(installation?.kind === "available");
    const session = await runtime.session(installation, { cwd, model: models[id], env: { ...env.env, CLAUDE_CONFIG_DIR: cwd, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
    const steer = session.steer?.bind(session) ?? assert.fail("steer unavailable");
    const pending: { controls?: Promise<readonly ControlResult[]> } = {};
    const timer = setTimeout(() => { void session.dispose(); }, 40_000);
    try {
      session.events((event) => {
        if (event.kind === "tool_call_started" && pending.controls === undefined) {
          pending.controls = (async (): Promise<readonly ControlResult[]> => {
            const sent = await steer(marker, { inputId });
            if (afterRead) {
              const deadline = Date.now() + 5000;
              while (!env.raw.some((request) => JSON.stringify(request.body).includes(marker))) {
                assert.ok(Date.now() < deadline, "steer never reached provider before deadline");
                await delay(10);
              }
            }
            return [sent, await session.abort()];
          })();
        }
      });
      const prompt = await session.prompt("run the waiting tool");
      const outcome = await awaitTurnEnd(session, prompt.request.seq);
      assert.ok(pending.controls, "no tool trigger");
      const results = await pending.controls;
      const answers = results.map((result) => result.response.body);
      const before = viewOf(session.records());
      const beforeCalls = env.raw.length;
      // A later prompt establishes whether a retained native steer is consumed then.
      const next = await session.prompt("report now");
      const nextOutcome = await awaitTurnEnd(session, next.request.seq);
      const report = {
        id, version: installation.via === "executable" ? installation.version : undefined, answers, outcome, nextOutcome,
        input: [...before.conversation.inputs.values()].find((entry) => entry.inputId === inputId),
        pending: before.pendingInputs.map((entry) => entry.inputId),
        provider: env.raw.map((request, index) => ({ afterNextPrompt: index >= beforeCalls, hasMarker: JSON.stringify(request.body).includes(marker) })),
        records: session.records(),
      };
      return report;
    } finally { clearTimeout(timer); await session.dispose(); }
  } finally { await env.stop(); await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }

}
