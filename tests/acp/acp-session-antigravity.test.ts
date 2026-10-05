import assert from "node:assert/strict";
import { expect, test, vi } from "vitest";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import {
  antigravityAcpArgs,
  antigravityAcpProfile,
  supportsAntigravityYolo,
} from "../../packages/oar/src/runtimes/antigravity/session.js";
import {
  antigravityInstallation,
  readAntigravityVersion,
} from "../../packages/oar/src/runtimes/antigravity/installation.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { describe, fixture } from "../fixtures/acp-session-support.js";

// The fixture's "antigravity" mode replays agy_acp_server 1.2.1: no `close`
// capability, no usage_update, no effort selector, and a session mode that
// every open (new or resume) starts back at `default`. The real profile runs
// against it, with only the launch line swapped for the fixture's.
async function startAntigravity(options: Omit<SessionOptions, "cwd"> = {}): Promise<Session> {
  return acpSession({
    ...antigravityAcpProfile,
    args: [fixture, "antigravity"],
  })({ kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd(), ...options });
}

async function lastText(session: Session, input: string): Promise<string | undefined> {
  const run = await promptAndWait(session, input);
  assert.equal(run.kind, "ended");
  return session.records().map((record) => describe(record)).findLast((line) => line.startsWith("event agent_message_chunk"));
}

test("the session opens without authenticate and runs in yolo, again after a resume", async () => {
  const first = await startAntigravity();
  const opening = first.records().map((record) => describe(record));
  assert.ok(!opening.includes("event authenticate"), JSON.stringify(opening));
  assert.equal(await lastText(first, "mode"), "event agent_message_chunk → text:mode:yolo");
  await first.dispose();

  const resumed = await startAntigravity({ resume: first.id });
  assert.equal(resumed.id, first.id);
  assert.equal(await lastText(resumed, "mode"), "event agent_message_chunk → text:mode:yolo");
  await resumed.dispose();
});

test("dispose ends the process without the session/close the agent does not advertise", async () => {
  const session = await startAntigravity();
  await session.dispose();
  const tail = session.records().map((record) => describe(record));
  assert.deepEqual(tail.slice(-2), ["request dispose", "response exited"]);
  // The fixture exits 3 on any session/close, so a null code means oar killed it without one.
  const exit = session.records().findLast((record) => record.kind === "response" && record.body.kind === "exited");
  assert.ok(exit?.kind === "response" && exit.body.kind === "exited");
  assert.equal(exit.body.code, null);
});

test("a model switch goes through the model config option and effort is refused", async () => {
  const session = await startAntigravity({ model: "requested-y" });
  const opening = session.records().map((record) => describe(record));
  assert.ok(opening.includes("event session/set_config_option → model:requested-y"), JSON.stringify(opening));
  assert.equal(session.model().value, "requested-y");
  await session.dispose();

  await expect(startAntigravity({ effort: "high" })).rejects.toMatchObject({
    name: "UnsupportedOptionError",
    option: "effort",
    message: "session/new advertises no thought_level config option, so effort high cannot be applied",
  });
});

test("a turn ends on the prompt answer alone, with no usage_update to wait for", async () => {
  const session = await startAntigravity();
  const run = await promptAndWait(session, "hello");
  assert.equal(run.kind, "ended");
  assert.deepEqual(run.outcome, { kind: "completed" });
  assert.ok(!session.records().some((record) => record.kind === "frame" && record.body.type === "usage_update"));
  await session.dispose();
});

test("the antigravity profile drops privileges only on linux and refuses a system prompt", () => {
  assert.deepEqual(antigravityAcpArgs("linux"), ["--uid="]);
  assert.deepEqual(antigravityAcpArgs("darwin"), []);
  assert.deepEqual(antigravityAcpArgs("win32"), []);
  assert.equal(antigravityAcpProfile.modelViaConfigOption, true);
  assert.equal(antigravityAcpProfile.selectAuthMethod, undefined);
  assert.equal(antigravityAcpProfile.capabilities.attribution, "opaque");
  assert.throws(() => antigravityAcpProfile.validateOptions?.({ cwd: "/", systemPrompt: "x" }));
  assert.throws(() => antigravityAcpProfile.validateOptions?.({ cwd: "/", appendSystemPrompt: "x" }));
  assert.doesNotThrow(() => antigravityAcpProfile.validateOptions?.({ cwd: "/" }));
});

test("yolo is found in the session modes or in the mode config option", () => {
  assert.ok(supportsAntigravityYolo({ modes: { availableModes: [{ id: "default" }, { id: "yolo" }] } }));
  assert.ok(supportsAntigravityYolo({ configOptions: [{ id: "mode", options: [{ value: "default" }, { value: "yolo" }] }] }));
  assert.ok(!supportsAntigravityYolo({ modes: { availableModes: [{ id: "default" }] }, configOptions: [] }));
});

test("antigravity reads its release from the Build label line", async () => {
  // agy_acp_server 1.2.1 `--version`: a build stamp whose first line is not the release.
  assert.equal(readAntigravityVersion("Built on Mon Sep 22 2026\nBuild label: 1.2.1\nBuild target: agy_acp_server\n"), "1.2.1");
  assert.equal(readAntigravityVersion("v24.0.0\n"), undefined);

  // Node's `--version` has no Build label, so the snapshot carries no version rather than a wrong one.
  vi.stubEnv("OAR_ANTIGRAVITY_BIN", process.execPath);
  const snapshot = await antigravityInstallation();
  vi.unstubAllEnvs();
  assert.deepEqual(snapshot, { kind: "available", via: "executable", command: process.execPath });
});
