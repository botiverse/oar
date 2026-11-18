/* oxlint-disable unicorn/no-useless-undefined -- Explicit empty capture state satisfies init-declarations. */
/* oxlint-disable eslint/no-await-in-loop -- Observe native own-work start before sending the next prompt. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { antigravityRuntime, promptAndWait, type RawEvent } from "../../packages/oar/src/index.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";

const [binary, output] = process.argv.slice(2);
assert.ok(binary !== undefined && output !== undefined);
const nextInput = "NEW_INSTRUCTION_298: reply with NEW_INSTRUCTION_FOLLOWED";
const requests: unknown[] = [];
let mainRequests = 0;
let newInstructionSeen = false;
const fixture = await startAntigravityAimock(mock => {
  mock.on({ predicate: () => true }, request => {
    const text = JSON.stringify(request.messages);
    if (text.includes("conversation title generator")) { return { content: "Activity boundary" }; }
    mainRequests += 1;
    requests.push({ at: Date.now(), messages: request.messages });
    if (text.includes(nextInput)) { newInstructionSeen = true; return { content: "NEW_INSTRUCTION_FOLLOWED" }; }
    if (mainRequests === 1) { return { toolCalls: [{ name: "run_command", arguments: JSON.stringify({ CommandLine: "sleep 4; echo BACKGROUND_DONE", WaitMsBeforeAsync: 500, toolSummary: "Background control" }) }] }; }
    if (mainRequests === 2) { return { content: "BACKGROUND_STARTED" }; }
    if (mainRequests === 3) { return { content: "OWN_WORK_STARTED", toolCalls: [{ name: "run_command", arguments: JSON.stringify({ CommandLine: "sleep 8; echo OWN_WORK_DONE", WaitMsBeforeAsync: 10_000, toolSummary: "Own work control" }) }] }; }
    return { content: "OWN_WORK_FINISHED" };
  });
});
const cwd = fixture.env.HOME;
assert.ok(cwd !== undefined);
const session = await antigravityRuntime.session({ kind: "available", via: "executable", command: path.resolve(binary) }, { cwd, env: fixture.env, model: "gemini-3.8-flash" });
const records: RawEvent[] = [];
session.rawEvents(record => { records.push(record); });
let failure: string | undefined = undefined;
let summary: unknown = undefined;
try {
  const first = await promptAndWait(session, "Start a background command, then report that it started.");
  assert.equal(first.kind, "ended");
  const firstEnd = records.at(-1)?.seq ?? -1;
  const deadline = Date.now() + 20_000;
  while (!records.some(record => record.seq > firstEnd && record.kind === "frame" && record.body.events.some(event => event.kind === "tool_call_started"))) {
    assert.ok(Date.now() < deadline, "native own command did not start");
    await delay(10);
  }
  const before = viewOf(records);
  const promptedAt = Date.now();
  const second = await promptAndWait(session, nextInput, { timeoutMs: 30_000 });
  const after = viewOf(records);
  assert.equal(second.kind, "ended");
  assert.ok(newInstructionSeen, "the new instruction must reach the native model request");
  assert.equal(before.status.kind, "idle");
  const activity = before.messages.find(message => message.kind === "activity");
  assert.ok(activity);
  assert.equal(after.messages.find(message => message.id === activity.id)?.kind, "activity");
  const final = after.messages.at(-1);
  assert.ok(final?.kind === "turn");
  assert.ok(final.sections.some(section => section.parts.some(part => part.kind === "text" && part.text.includes("NEW_INSTRUCTION_FOLLOWED"))));
  summary = { first, second, promptedAt, newInstructionSeen, mainRequests, before, after };
} catch (error) { failure = String(error); }
finally {
  await writeFile(output, JSON.stringify({ version: "1.5.11", error: failure, summary, records, requests }, null, 2));
  await session.dispose();
  await fixture.stop();
}
assert.equal(failure, undefined);
console.log(JSON.stringify({ output, newInstructionSeen, mainRequests }));
