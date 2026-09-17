import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { runtimes, awaitTurnEnd, conversationOf, type ControlResult } from "../../packages/oar/src/index.js";
import { startClaudeAimock, startCodexAimock } from "../harness/aimock.js";

async function verifyIdentity(id: "codex" | "claude", mode: "steer" | "fallback"): Promise<void> {
  const inputId = "11111111-2222-4333-8444-555555555555";
  const marker = "input-identity-probe";
  const provider: boolean[] = [];
  const env = await (id === "codex" ? startCodexAimock : startClaudeAimock)((mock) => {
    mock.onMessage(/[\s\S]*/u, (request: { messages?: unknown }) => {
      provider.push(JSON.stringify(request.messages).includes(marker));
      const command = 'node -e "setTimeout(()=>console.log(123),500)"';
      return provider.length === 1
        ? { toolCalls: [{ name: id === "codex" ? "exec_command" : "Bash", arguments: JSON.stringify(id === "codex" ? { cmd: command } : { command }) }] }
        : { content: "done" };
    });
  });
  const cwd = await mkdtemp(path.join(tmpdir(), "oar-input-identity-"));
  try {
    const runtime = runtimes.require(id);
    const installation = await runtime.installation?.();
    assert.ok(installation?.kind === "available");
    const session = await runtime.session(installation, { cwd, model: id === "codex" ? "gpt-5.1" : "haiku", env: { ...env.env, CLAUDE_CONFIG_DIR: cwd, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
    const pending: { steer?: Promise<ControlResult> } = {};
    const timer = setTimeout(() => { void session.dispose(); }, 30_000);
    try {
      session.events((event) => {
        if (mode === "steer" && event.kind === "tool_call_started" && pending.steer === undefined) {pending.steer = session.steer(marker, { inputId });}
      });
      const started = mode === "steer" ? await session.prompt("run a tool") : await session.steerOrQueue(marker, { inputId });
      const prompt = "landed" in started ? started.result : started;
      assert.deepEqual(await awaitTurnEnd(session, prompt.request.seq), { kind: "completed" });
      const steer = mode === "steer" ? await pending.steer : prompt;
      assert.ok(steer !== undefined);
      assert.equal(steer.response.body.kind, "accepted");
      const input = [...conversationOf(session.records()).inputs.values()].find((entry) => entry.inputId === inputId);
      assert.equal(input?.attempts.length, mode === "steer" ? 1 : 2);
      assert.equal(input.observations.length, 1);
      assert.equal(input.observations[0]?.evidence, id === "codex" ? "turn_item" : "acknowledged");
      assert.ok(provider.includes(true));
    } finally { clearTimeout(timer); await session.dispose(); }
  } finally { await env.stop(); await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
for (const id of ["codex", "claude"] as const) {
  test.skipIf(process.env.OAR_TEST !== `${id}-aimock`).each(["steer", "fallback"] as const)(`${id} correlates native %s echo without a duplicate input`, async (mode) => { await verifyIdentity(id, mode); }, 60_000);
}
