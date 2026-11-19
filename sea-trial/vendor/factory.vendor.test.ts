import { expect, test } from "vitest";
import { factoryRuntime } from "../../packages/oar/src/runtimes/factory/index.js";
import { awaitIdle, awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { eventsOf } from "../../packages/oar/src/observe/events.js";
import type { RawEvent } from "../../packages/oar/src/contracts/session.js";
import { FACTORY_AIMOCK_MODEL, startFactoryAimock } from "../harness/factory-aimock.js";
import { ECHO_SERVER } from "./support/echo-mcp.js";
import { expectAvailable } from "./support/asserts.js";

/*
 * Factory droid's native stream-jsonrpc against a scripted provider
 * (docs/runtimes/factory.md). Each case pins a droid behavior the adapter
 * relies on: steering folds into the running turn, an interrupt drops
 * undrained steering by RPC id, tools run without a permission prompt, MCP
 * servers attach, and provider failures keep droid's own turn-end reason.
 */
const enabled = process.env.OAR_TEST === "factory-aimock";
const events = (records: readonly RawEvent[]) => records.flatMap(record => eventsOf(record));

async function open(configure: Parameters<typeof startFactoryAimock>[0], extra: Partial<Parameters<typeof factoryRuntime.session>[1]> = {}) {
  const provider = await startFactoryAimock(configure);
  const installation = await factoryRuntime.installation();
  expectAvailable(installation, "Factory droid");
  const session = await factoryRuntime.session(installation, { cwd: provider.cwd, env: provider.env, model: FACTORY_AIMOCK_MODEL, ...extra });
  return { provider, session };
}

test.skipIf(!enabled)("a steer joins the running turn: one turn end, the steer echoed under its inputId, usage and context reported", async () => {
  const { provider, session } = await open((mock) => {
    mock.onMessage(/SLOW_FIRST/u, { content: "first-answer" }, { latency: 2500 });
    mock.onMessage(/^(?![\s\S]*SLOW_FIRST)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
  });
  try {
    const prompt = await session.prompt("SLOW_FIRST");
    expect(prompt.response.body.kind).toBe("accepted");
    await new Promise((resolve) => { setTimeout(resolve, 800); });
    const steer = await session.steer?.("STEER_SECOND", { inputId: "11111111-2222-4333-8444-555555555555" });
    expect(steer?.response.body.kind).toBe("accepted");
    expect(await awaitIdle(session)).toEqual({ kind: "completed" });
    const seen = events(session.records());
    expect(seen.filter(event => event.kind === "turn_ended")).toHaveLength(1);
    expect(seen).toContainEqual(expect.objectContaining({ kind: "user_message", input: "STEER_SECOND", inputId: "11111111-2222-4333-8444-555555555555", evidence: "turn_item" }));
    const last = provider.mock.getRequests().at(-1);
    expect(JSON.stringify(last?.body)).toContain("STEER_SECOND");
    expect(session.usage().value.total?.input).toBeGreaterThan(0);
    expect(session.contextUsage().value?.tokens).toBeTypeOf("number");
    expect(session.contextUsage().value?.contextWindow).toBeGreaterThan(0);
  } finally { await session.dispose(); await provider.stop(); }
}, 90_000);

test.skipIf(!enabled)("abort ends the turn as aborted and returns undrained steering as dropped", async () => {
  const { provider, session } = await open((mock) => {
    mock.onMessage(/[\s\S]*/u, { content: "late" }, { latency: 5000 });
  });
  try {
    const prompt = await session.prompt("SLOW_ABORTED");
    await expect.poll(() => provider.mock.getRequests().some(r => r.body !== null && JSON.stringify(r.body.messages).includes("SLOW_ABORTED") && Array.isArray(r.body.tools) && r.body.tools.length > 0), { timeout: 15_000 }).toBe(true);
    const steer = await session.steer?.("NEVER_DRAINED");
    expect(steer?.response.body.kind).toBe("accepted");
    const abort = await session.abort();
    expect(abort.response.body.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "aborted" });
    expect(events(session.records())).toContainEqual(expect.objectContaining({ kind: "input_dropped", reason: "turn_interrupted", requestId: steer?.request.id }));
  } finally { await session.dispose(); await provider.stop(); }
}, 90_000);

test.skipIf(!enabled)("an abort right after the prompt settles the input, and a later abort finds no turn", async () => {
  const { provider, session } = await open((mock) => { mock.onMessage(/[\s\S]*/u, { content: "late" }, { latency: 3000 }); });
  try {
    const prompt = await session.prompt("ABORTED_EARLY");
    const abort = await session.abort();
    expect(abort.response.body.kind).toBe("accepted");
    // droid either hands the prompt back before starting it (input_dropped) or cancels its turn.
    expect(await awaitIdle(session)).not.toMatchObject({ kind: "failed" });
    const late = await session.abort();
    expect(late.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    expect(prompt.response.body.kind).toBe("accepted");
  } finally { await session.dispose(); await provider.stop(); }
}, 90_000);

test.skipIf(!enabled)("compact summarizes in the same session between turns, and is refused during a turn or on an empty conversation", async () => {
  const { provider, session } = await open((mock) => {
    mock.onMessage(/SLOW_TURN/u, { content: "slow" }, { latency: 3000 });
    mock.onMessage(/^(?![\s\S]*SLOW_TURN)[\s\S]*$/u, { content: "ok" }, { latency: 50 });
  });
  try {
    const empty = await session.compact?.({ timeoutMs: 30_000 });
    expect(empty).toMatchObject({ kind: "rejected", code: "runtime_refused" });
    await promptAndWait(session, "first", { timeoutMs: 30_000 });
    await promptAndWait(session, "second", { timeoutMs: 30_000 });
    const compacted = await session.compact?.({ timeoutMs: 30_000 });
    expect(compacted).toMatchObject({ kind: "completed", frame: { body: { type: "droid.compact_session", responseTo: compacted?.request.id } } });
    expect(session.records().flatMap(record => record.kind === "frame" ? record.body.events : [])).toContainEqual({ kind: "compaction_ended", outcome: "completed" });
    const run = await promptAndWait(session, "after", { timeoutMs: 30_000 });
    expect(run).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    await session.prompt("SLOW_TURN");
    const busy = await session.compact?.({ timeoutMs: 30_000 });
    expect(busy).toMatchObject({ kind: "rejected", code: "busy" });
    await awaitIdle(session);
  } finally { await session.dispose(); await provider.stop(); }
}, 90_000);

test.skipIf(!enabled)("tools run without a permission prompt, and an attached MCP server's tool is called", async () => {
  const { provider, session } = await open((mock) => {
    // One tool round, then a reply: the call's result is the last message the model sees.
    mock.on({ predicate: request => request.messages.at(-1)?.role === "tool" }, { content: "done" });
    mock.onMessage(/RUN_TOOLS/u, { toolCalls: [{ name: "echo___echo", arguments: JSON.stringify({ text: "via-oar" }) }] }, { latency: 50 });
  }, { mcpServers: [{ name: "echo", command: process.execPath, args: [ECHO_SERVER], env: { OAR_ECHO_TOKEN: "factory-vendor-secret-token" } }] });
  try {
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    const run = await promptAndWait(session, "RUN_TOOLS", { timeoutMs: 60_000 });
    expect(run).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const seen = events(session.records());
    expect(seen).toContainEqual(expect.objectContaining({ kind: "tool_call_started", tool: "echo___echo" }));
    const ended = seen.find(event => event.kind === "tool_call_ended");
    expect(ended).toMatchObject({ result: "ok" });
    expect(JSON.stringify(ended)).toContain("echo:via-oar");
    expect(session.records().some(record => record.kind === "request" && record.direction === "toApp")).toBe(false);
    expect(JSON.stringify(session.records())).not.toContain("factory-vendor-secret-token");
  } finally { await session.dispose(); await provider.stop(); }
}, 90_000);

test.skipIf(!enabled)("a provider's 401 ends the turn as an auth failure in droid's words", async () => {
  const { provider, session } = await open((mock) => {
    mock.onMessage(/[\s\S]*/u, { status: 401, error: { type: "invalid_request_error", code: "invalid_api_key", message: "Invalid synthetic key" } });
  });
  try {
    const run = await promptAndWait(session, "FAILS", { timeoutMs: 60_000 });
    expect(run).toMatchObject({ kind: "ended", outcome: { kind: "failed", failure: "auth" } });
    expect(JSON.stringify(run)).toContain("Invalid synthetic key");
  } finally { await session.dispose(); await provider.stop(); }
}, 90_000);

test.skipIf(!enabled)("an unknown resume id is SessionNotFoundError, and a model droid would not run refuses the open", async () => {
  const provider = await startFactoryAimock();
  try {
    const installation = await factoryRuntime.installation();
    expectAvailable(installation, "Factory droid");
    await expect(factoryRuntime.session(installation, { cwd: provider.cwd, env: provider.env, resume: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ name: "SessionNotFoundError" });
    await expect(factoryRuntime.session(installation, { cwd: provider.cwd, env: provider.env, model: "no-such-model" })).rejects.toMatchObject({ name: "ModelConfirmationError", requested: "no-such-model" });
    await expect(factoryRuntime.session(installation, { cwd: provider.cwd, env: provider.env, model: FACTORY_AIMOCK_MODEL, effort: "high" })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "effort" });
    await expect(factoryRuntime.session(installation, { cwd: provider.cwd, env: provider.env, model: FACTORY_AIMOCK_MODEL, effort: "bogus" })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "effort" });
  } finally { await provider.stop(); }
}, 90_000);

test.skipIf(!enabled)("listModels reads droid's catalog with the custom model and its effort menu", async () => {
  const provider = await startFactoryAimock();
  try {
    const installation = await factoryRuntime.installation();
    expectAvailable(installation, "Factory droid");
    const listed = await factoryRuntime.listModels(installation, { cwd: provider.cwd, env: provider.env });
    expect(listed.kind).toBe("ok");
    expect(listed.kind === "ok" ? listed.models.find(model => model.id === FACTORY_AIMOCK_MODEL) : null).toMatchObject({ displayName: "Aimock", effortLevels: ["none"] });
  } finally { await provider.stop(); }
}, 60_000);

