/**
 * OBSERVED (2026-08-24, codex 0.148.0, Linux):
 * A Coxswain AgentHost prompt instructed Codex to invoke the bridge through
 * OAR_SAY; an agent conversation event arrived with the requested marker.
 * Activity also carried an explicitly redacted reasoning event, the env-var
 * command input, and a clean `exit 0` result. The bridge no longer depends on
 * PATH lookup.
 *
 * Run: pnpm tsx experiments/coxswain-say-bridge.ts
 */
import assert from "node:assert/strict";
import { AgentHost } from "../apps/coxswain/src/main/agent.js";
import type { SessionEventView } from "../apps/coxswain/src/shared/ipc.js";

const MARKER = "coxswain OAR_SAY bridge delivered";

async function main(): Promise<void> {
  const host = new AgentHost();
  const activity: SessionEventView[] = [];
  const hostErrors: string[] = [];
  const finished = Promise.withResolvers<string>();
  let delivered: string | null = null;
  let turnEnded = false;
  const settleWhenComplete = (): void => {
    if (delivered !== null && turnEnded) {
      finished.resolve(delivered);
    }
  };
  const unsubscribe = host.subscribe((event) => {
    if (event.kind === "activity") {
      activity.push(event.event);
    } else if (event.kind === "conversation" && event.entry.kind === "agent") {
      delivered = event.entry.text;
      settleWhenComplete();
    } else if (event.kind === "conversation" && event.entry.kind === "outcome") {
      turnEnded = true;
      if (delivered === null) {
        finished.reject(new Error(`turn ended before say delivery: ${JSON.stringify({
          activity,
          hostErrors,
          outcome: event.entry.outcome,
        })}`));
      } else {
        settleWhenComplete();
      }
    } else if (event.kind === "host_error") {
      hostErrors.push(event.message);
    }
  });
  const timeout = setTimeout(() => {
    finished.reject(new Error(`no agent conversation event arrived within 60 seconds: ${JSON.stringify({
      activity,
      hostErrors,
    })}`));
  }, 60_000);

  try {
    await host.inspect();
    await host.launch({ runtimeId: "codex", cwd: process.cwd() });
    const receipt = await host.submit(`Reply with exactly "${MARKER}" through the instructed bridge.`);
    assert.equal(receipt.landed, "prompted", `submit receipt: ${JSON.stringify(receipt)}`);
    const text = await finished.promise;
    assert.equal(text, MARKER, `delivered text: ${JSON.stringify(text)}`);
    const command = activity.find((event) =>
      event.kind === "tool_call_started" && event.tool === "commandExecution");
    assert.ok(command?.kind === "tool_call_started", `activity: ${JSON.stringify(activity)}`);
    assert.match(command.input ?? "", /OAR_SAY/u, `command input: ${JSON.stringify(command.input)}`);
    const completed = activity.find((event) =>
      event.kind === "tool_call_ended" && event.callId === command.callId);
    assert.ok(completed?.kind === "tool_call_ended", `activity: ${JSON.stringify(activity)}`);
    assert.equal(completed.output, "exit 0", `command output: ${JSON.stringify(completed.output)}`);
    const reasoning = activity.find((event) => event.kind === "reasoning");
    assert.ok(reasoning?.kind === "reasoning", `activity: ${JSON.stringify(activity)}`);
    assert.equal(reasoning.content.kind, "redacted", `reasoning: ${JSON.stringify(reasoning)}`);
    process.stdout.write(`PASS ${text}\n`);
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    await host.dispose();
  }
}

await main();
