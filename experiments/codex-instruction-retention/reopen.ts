/* oxlint-disable no-await-in-loop -- Each case seeds, closes and reopens one persistent native thread. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { codexRuntime, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startCodexAimock, type RawProviderRequest } from "../../sea-trial/harness/aimock.js";

const seedMark = "OAR_APPEND_ON_ORIGINAL_THREAD";
const newMark = "OAR_APPEND_ON_REOPEN";
type Operation = "resume" | "fork";

async function sample(session: Session, prompt: string, raw: readonly RawProviderRequest[]): Promise<string[]> {
  const begin = raw.length;
  const turn = await promptAndWait(session, prompt, { timeoutMs: 30_000 });
  assert.ok(turn.kind === "ended" && turn.outcome.kind === "completed");
  const matched = raw.slice(begin).map(({ body }) => asRecord(body)?.input).filter(input => Array.isArray(input)).map(input => input.map(item => asRecord(item))).filter(input => {
    const message = input.findLast(item => item?.role === "user");
    return Array.isArray(message?.content) && message.content.some(part => asRecord(part)?.text === prompt);
  });
  assert.equal(matched.length, 1);
  const captured = matched.at(0);
  assert.ok(captured !== undefined);
  return [seedMark, newMark].filter(marker => captured.some(item =>
    item?.role === "developer" && Array.isArray(item.content) && item.content.some(part => asRecord(part)?.text === marker)));
}

// oxlint-disable-next-line max-statements -- The pre/post observations need the same reopened session.
async function measure(operation: Operation, supplied: "same" | "changed" | "omitted"): Promise<JsonRecord> {
  const fixture = await startCodexAimock(undefined, { captureRaw: true, warmHome: false });
  const home = fixture.env?.CODEX_HOME;
  assert.ok(home !== undefined);
  const cwd = join(home, "project");
  const blockedProxy = "http://127.0.0.1:9";
  const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...fixture.env, HOME: home, USERPROFILE: home,
    PATH: process.env.PATH ?? "", HTTP_PROXY: blockedProxy, HTTPS_PROXY: blockedProxy, ALL_PROXY: blockedProxy, NO_PROXY: "localhost,127.0.0.1" };
  const options = { cwd, env, model: "gpt-6.2-sol" };
  let live: Session | undefined = undefined;
  try {
    await mkdir(cwd);
    const installation = await codexRuntime.installation();
    assert.ok(installation.kind === "available" && installation.via === "executable");
    live = await codexRuntime.session(installation, { ...options, appendSystemPrompt: seedMark });
    const original = await sample(live, "OAR_SEED_HISTORY", fixture.raw);
    assert.deepEqual(original, [seedMark]);
    const { id } = live;
    await live.dispose();
    const prompts = { same: { appendSystemPrompt: seedMark }, changed: { appendSystemPrompt: newMark }, omitted: {} };
    live = await codexRuntime.session(installation, { ...options, resume: id, ...(operation === "fork" ? { fork: {} } : {}), ...prompts[supplied] });
    assert.equal(live.id === id, operation === "resume");
    const before = await sample(live, "OAR_REOPEN_BEFORE", fixture.raw);
    const result = await live.compact?.({ timeoutMs: 30_000 });
    assert.equal(result?.kind, "completed");
    const after = await sample(live, "OAR_REOPEN_AFTER", fixture.raw);
    const expected = prompts[supplied];
    assert.deepEqual(after, "appendSystemPrompt" in expected ? [expected.appendSystemPrompt] : []);
    return { version: installation.version, operation, supplied, sameThreadId: live.id === id, original, before, compact: result.kind, after };
  } finally {
    try { await live?.dispose(); } finally { await fixture.stop(); }
  }
}

assert.ok(process.env.OAR_CODEX_BIN !== undefined, "Set OAR_CODEX_BIN to the native executable under test");
const results = [];
for (const operation of ["resume", "fork"] as const) {
  for (const supplied of ["same", "changed", "omitted"] as const) { results.push(await measure(operation, supplied)); }
}
console.log(JSON.stringify(results, null, 2));
