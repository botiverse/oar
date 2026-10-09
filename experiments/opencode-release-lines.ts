/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function -- Each native probe keeps its control sequence and assertions together. */
/**
 * OpenCode v1/v2 boundary probe, October 9, 2026. Uses only the free Big Pickle model.
 * pnpm tsx experiments/opencode-release-lines.ts <binary> <cwd> <output-directory> [check ...]
 * Records complete native frames, graph attribution, controls, prompt options and resume.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { opencodeSession, opencodeRuntime, awaitTurnEnd, type Session, type SessionOptions, type RuntimeEventBody, type StartSession } from "../packages/oar/src/index.js";
import { acpSession } from "../packages/oar/src/shared/acp/session.js";
import { opencodeV2AcpProfile } from "../packages/oar/src/runtimes/opencode/session.js";

const [binary, cwd, out] = process.argv.slice(2);
assert.ok(binary !== undefined && cwd !== undefined && out !== undefined, "usage: <binary> <cwd> <output-directory>");
const outputDirectory = out;
const selectedChecks = new Set(process.argv.slice(5));
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
const v2 = version.startsWith("opencode v2.");
const installation = { kind: "available", via: "executable", command: binary, version } as const;
const options = { cwd, model: "opencode/big-pickle" };
mkdirSync(out, { recursive: true });
const results: Record<string, unknown> = { version };

function events(session: Session): readonly RuntimeEventBody[] {
  return session.records().flatMap((record) => record.kind === "frame" && record.sessionId === session.id ? record.body.events : []);
}
function text(session: Session): string {
  return events(session).flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("");
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timeout: ${label}`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Poll the same native session.
    await delay(50);
  }
}
async function capture(name: string, { start = opencodeSession, ...extra }: Partial<SessionOptions> & { start?: StartSession }, run: (session: Session) => Promise<void>): Promise<string> {
  const session = await start(installation, { ...options, ...extra });
  try { await run(session); } finally {
    await session.dispose();
    writeFileSync(path.join(outputDirectory, `${name}.json`), JSON.stringify({ id: session.id, capabilities: session.capabilities, graph: session.graph(), records: session.records() }, null, 2));
  }
  return session.id;
}
async function prompt(session: Session, input: string): Promise<void> {
  const accepted = await session.prompt(input);
  assert.equal(accepted.kind, "accepted");
  await until(() => session.records().some((record) => record.seq > accepted.seq && record.kind === "frame" && record.body.events.some((event) => event.kind === "turn_ended")), "prompt answer");
  const outcome = await awaitTurnEnd(session, accepted.seq);
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
}
async function check(name: string, run: () => Promise<unknown>): Promise<void> {
  if (selectedChecks.size > 0 && !selectedChecks.has(name)) { return; }
  try { results[name] = { status: "pass", facts: await run() }; }
  catch (error) { results[name] = { status: "fail", error: String(error) }; process.exitCode = 1; }
  writeFileSync(path.join(outputDirectory, "report.json"), JSON.stringify(results, null, 2));
  process.stdout.write(`${name}: ${JSON.stringify(results[name])}\n`);
}

await check("catalog", async () => {
  const catalog = await opencodeRuntime.listModels(installation);
  assert.equal(catalog.kind, v2 ? "unsupported" : "ok");
  return catalog.kind === "ok" ? { kind: catalog.kind, count: catalog.models.length } : catalog;
});
for (const option of ["appendSystemPrompt", "systemPrompt"] as const) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- Keep native prompt-option probes separate.
  await check(option, async () => {
    if (v2) {
      await assert.rejects(opencodeSession(installation, { ...options, [option]: "The secret word is KIWI-4471." }), { name: "UnsupportedOptionError", option });
      return { refused: option };
    }
    let reply = "";
    await capture(option, { [option]: "The secret word is KIWI-4471." }, async (session) => {
      await prompt(session, "What is the secret word in your instructions? Reply only with the word, or NONE.");
      reply = text(session);
      assert.ok(reply.includes("KIWI-4471"), reply);
    });
    return { reply };
  });
}
await check("control", async () => {
  let facts: unknown = null;
  await capture("control", {}, async (session) => {
    assert.equal("steer" in session, !v2);
    const first = await session.prompt("Run the exact shell command `sleep 5; echo FIRST_DONE`. After it finishes reply ALPHA, unless a later instruction gives you a different word.");
    assert.equal(first.kind, "accepted");
    await until(() => events(session).some((event) => event.kind === "tool_call_started"), "shell start");
    const followup = await session.steerOrQueue("The new word is BANANA. Reply only BANANA.");
    assert.equal(followup.landed, v2 ? "queued" : "steered");
    await until(() => events(session).filter((event) => event.kind === "turn_ended").length >= (v2 ? 2 : 1), "control turns");
    const outcomes = events(session).filter((event) => event.kind === "turn_ended");
    assert.ok(outcomes.every((event) => event.outcome.kind === "completed"), JSON.stringify(outcomes));
    assert.ok(text(session).includes("BANANA"), text(session));
    facts = { landed: followup.landed, outcomes, reply: text(session), model: session.model().value, effort: session.effort().value };
  });
  return facts;
});
await check("children", async () => {
  let facts: unknown = null;
  await capture("children", {}, async (session) => {
    await prompt(session, "Use the task/subagent tool to start exactly one general subagent whose only job is to run `echo CHILD-OK-7731` in its shell and report the output. Do not run the shell command yourself. Reply with its reported output.");
    const childFrames = session.records().filter((record) => record.kind === "frame" && record.sessionId !== session.id);
    assert.equal(childFrames.length > 0, v2);
    assert.equal(session.graph().edges.length > 0, v2);
    assert.ok(text(session).includes("CHILD-OK-7731"), text(session));
    facts = { childFrames: childFrames.length, graph: session.graph(), rootReply: text(session), tier: session.capabilities.attribution };
  });
  return facts;
});
await check("resume", async () => {
  const id = await capture("resume-before", {}, async (session) => { await prompt(session, "Remember this secret: PLUM-42. Reply OK."); });
  let reply = "";
  await capture("resume-after", { resume: id }, async (session) => {
    assert.equal(session.id, id);
    await prompt(session, "What secret did I ask you to remember? Reply only with it.");
    reply = text(session);
    assert.ok(reply.includes("PLUM-42"), reply);
  });
  return { sameId: true, reply };
});

await check("mcp", async () => {
  const mcpServers = [{ name: "echo", command: process.execPath, args: [fileURLToPath(new URL("../tests/fixtures/echo-mcp-server.mjs", import.meta.url))] }];
  const replies: string[] = [];
  let resume: string | null = null;
  for (const token of ["MCP_NEW_271", "MCP_RESUMED_271"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Resume the just-closed native session with MCP supplied again.
    resume = await capture(token, { mcpServers, ...(resume === null ? {} : { resume }) }, async (session) => {
      await prompt(session, `Call the echo MCP tool with text ${token}. Reply with the exact tool result. Do not use shell or fake a tool result.`);
      const toolResults = events(session).filter((event) => event.kind === "tool_call_ended");
      assert.ok(JSON.stringify(toolResults).includes(`echo:${token} via=stdio token=none`), JSON.stringify(toolResults));
      if (v2) { assert.ok(events(session).some((event) => event.kind === "tool_call_started" && event.tool === "execute")); }
      replies.push(text(session));
    });
  }
  return { replies, resumed: true, via: v2 ? "execute" : "native MCP tool" };
});

for (const method of ["abort", "dispose"] as const) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- Keep the native process lifetimes independent.
  await check(method, async () => {
    let outcome: unknown = null;
    await capture(method, {}, async (session) => {
      const accepted = await session.prompt("Run exactly `sleep 30; echo TOO_LATE` in your shell, then reply DONE.");
      assert.equal(accepted.kind, "accepted");
      await until(() => events(session).some((event) => event.kind === "tool_call_started"), "interruptible tool start");
      await session[method]();
      outcome = await awaitTurnEnd(session, accepted.seq);
      assert.deepEqual(outcome, { kind: "aborted" });
    });
    return outcome;
  });
}

await check("steer-refusal", async () => {
  if (!v2) { return { applicable: false }; }
  let facts: unknown = null;
  // Probe-only raw concurrent prompt: the actual v2 adapter deliberately has no steer.
  const forced = acpSession({ ...opencodeV2AcpProfile, steerParams: () => ({}) });
  await capture("steer-refusal", { start: forced }, async (session) => {
    const original = await session.prompt("Run exactly `sleep 5; echo ORIGINAL_271` in your shell, then reply ORIGINAL_271.");
    await until(() => events(session).some((event) => event.kind === "tool_call_started"), "active prompt");
    const steered = await session.steer?.("Reply STEERED_271 instead.", { inputId: "21785c6a-0777-49b2-a985-8cfe2ef441a3" });
    assert.equal(steered?.kind, "accepted");
    await until(() => events(session).some((event) => event.kind === "input_dropped" && event.reason === "runtime_refused"), "native refusal");
    assert.equal(session.status().value.kind, "running");
    const outcome = await awaitTurnEnd(session, original.seq);
    assert.deepEqual(outcome, { kind: "completed" });
    facts = { steered, outcome, reply: text(session) };
  });
  return facts;
});
