import assert from "node:assert/strict";
import { expect, test } from "vitest";
import {
  cursorAcpArgs,
  cursorAcpProfile,
  cursorClientCapabilitiesMeta,
  selectCursorAuthMethod,
} from "../../packages/oar/src/runtimes/cursor/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { describe, fixture, start, tail } from "../fixtures/acp-session-support.js";

// The fixture's "cursor" mode replays cursor-agent 2026.09.28: the effort
// selector exists only for a client that declares
// `clientCapabilities._meta.parameterizedModelPicker`, and a model switch is
// answered only through `session/set_config_option` on the `model` option.
const cursorHooks = {
  args: [fixture, "cursor"],
  clientCapabilitiesMeta: cursorClientCapabilitiesMeta,
  modelViaConfigOption: true,
} as const;

test("the client capability opt-in is what makes the agent advertise effort", async () => {
  const session = await start(cursorHooks, undefined, undefined, "high");
  assert.equal(session.effort().value, "high");
  await session.dispose();

  await expect(start({ args: [fixture, "cursor"] }, undefined, undefined, "high")).rejects.toThrow(
    "session/new advertises no thought_level config option, so effort high cannot be applied",
  );
});

test("a model switch through the model config option is read back from its answer", async () => {
  const session = await start(cursorHooks, undefined, "requested-y");
  const opening = session.records().map((record) => describe(record));
  assert.ok(opening.includes("event session/set_config_option → model:requested-y, effort:medium"), JSON.stringify(opening));
  assert.ok(!opening.includes("event session/set_model"), JSON.stringify(opening));
  assert.equal(session.model().value, "requested-y");
  await session.dispose();
});

test("effort after a model switch is set against the switched model's menu", async () => {
  const session = await start(cursorHooks, undefined, "requested-y", "low");
  assert.equal(session.model().value, "requested-y");
  assert.equal(session.effort().value, "low");
  await session.dispose();
});

test("an unknown model is refused rather than silently kept", async () => {
  await expect(start(cursorHooks, undefined, "no-such-model")).rejects.toThrow("Invalid params");
});

test("a listed vendor request is recorded, then refused as the SDK refuses any unknown method", async () => {
  const session = await start({ extensionRequests: cursorAcpProfile.extensionRequests ?? [] });
  const run = await promptAndWait(session, "ask-question");
  assert.equal(run.kind, "ended");
  assert.deepEqual(tail(session, run.result.request.seq - 1), [
    "request prompt",
    "response accepted",
    "toApp cursor/ask_question",
    "response answered",
    "event agent_message_chunk → text:ask:-32601",
    "event session/prompt → turn_ended:completed",
  ]);
  const asked = session.records().find((record) => record.kind === "request" && record.direction === "toApp");
  assert.ok(asked?.kind === "request" && asked.body.kind === "native");
  expect(asked.body.native).toMatchObject({ questions: [{ id: "q1" }] });
  await session.dispose();
});

test("an unlisted vendor request gets the same refusal with nothing recorded", async () => {
  const unlisted = await start();
  const quiet = await promptAndWait(unlisted, "ask-question");
  assert.ok(quiet.kind === "ended");
  assert.deepEqual(tail(unlisted, quiet.result.request.seq - 1).slice(2, 3), ["event agent_message_chunk → text:ask:-32601"]);
  await unlisted.dispose();
});

test("the cursor profile runs ACP with auto approval and opts into the parameterized picker", () => {
  assert.deepEqual(cursorAcpArgs, ["--force", "acp"]);
  assert.equal(cursorAcpProfile.args, cursorAcpArgs);
  assert.equal(cursorAcpProfile.modelViaConfigOption, true);
  assert.deepEqual(cursorClientCapabilitiesMeta(), { parameterizedModelPicker: true });
  assert.equal(selectCursorAuthMethod({ authMethods: [{ id: "cursor_login" }] }), "cursor_login");
  assert.equal(selectCursorAuthMethod({ authMethods: [] }), undefined);
  assert.throws(() => cursorAcpProfile.validateOptions?.({ cwd: "/", systemPrompt: "x" }));
  assert.throws(() => cursorAcpProfile.validateOptions?.({ cwd: "/", appendSystemPrompt: "x" }));
});
