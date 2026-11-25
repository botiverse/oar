/* oxlint-disable import/max-dependencies -- This test composes the runtime entry, ACP harness and public contract in one place. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { SessionNotFoundError } from "../../packages/oar/src/contracts/session-not-found-error.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { acpSession, type AcpSessionProfile } from "../../packages/oar/src/shared/acp/session.js";
import { hermesListModels, projectHermesModels } from "../../packages/oar/src/runtimes/hermes/list-models.js";
import { hermesAcpProfile } from "../../packages/oar/src/runtimes/hermes/session.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-acp-hermes.mjs", import.meta.url));
const install = { kind: "available", via: "executable", command: process.execPath } as const;

const tempDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function open(overrides: Partial<AcpSessionProfile> = {}, env: Record<string, string | null> = {}): Promise<Session> {
  const profile: AcpSessionProfile = { ...hermesAcpProfile, ...overrides, args: [fixture] };
  return acpSession(profile)(install, { cwd: process.cwd(), env });
}

function writeHermesWrapper(dir: string, script: string): string {
  if (process.platform === "win32") {
    const cmd = path.join(dir, "hermes.cmd");
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const bin = path.join(dir, "hermes");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function bareHermes(): string {
  const dir = scratch("oar-hermes-bin-");
  const script = path.join(dir, "hermes-fixture.mjs");
  writeFileSync(script, [
    'import { appendFileSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    String.raw`if (process.env.HERMES_TEST_LOG) appendFileSync(process.env.HERMES_TEST_LOG, args.join(" ") + "\n");`,
    String.raw`if (args[0] === 'acp' && args[1] === '--check') { process.stdout.write('Hermes ACP check OK\n'); process.exit(0); }`,
    String.raw`if (args[0] === '--version') { process.stdout.write('Hermes Agent v0.23.3+1139.g084538c (2026.9.24) · stable · local 084538cdb605\n'); process.exit(0); }`,
    "process.exit(2);",
  ].join("\n"));
  return writeHermesWrapper(dir, script);
}

function completedText(session: Session): string[] {
  return session.records().flatMap((record) => record.kind === "frame" ? record.body.events : [])
    .flatMap((event) => event.kind === "text_delta" ? [event.text] : []);
}

// oxlint-disable-next-line eslint/max-statements -- The fork, active delivery, and receipt belong to one scenario.
test("Hermes steers a branch's original prompt using the advertised control, not a second prompt", async () => {
  const logPath = path.join(scratch("oar-hermes-steer-"), "calls");
  const session = await acpSession({ ...hermesAcpProfile, args: [fixture] })(install, {
    cwd: process.cwd(), resume: "local-fake-hermes", fork: {},
    env: { FAKE_HERMES_STEER: "yes", FAKE_HERMES_CALL_LOG: logPath },
  });
  try {
    assert.equal(typeof session.steer, "function");
    const idle = await session.steer?.("idle");
    assert.equal(idle?.kind, "rejected");
    const turn = promptAndWait(session, "hold");
    await expect.poll(() => readFileSync(logPath, "utf8")).toContain("prompt:hold");
    const result = await session.steerOrQueue("use the branch");
    assert.equal(result.landed, "steered");
    const ended = await turn;
    assert.equal(ended.kind, "ended");
    assert.deepEqual(completedText(session), ["echo:use the branch"]);
    assert.deepEqual(readFileSync(logPath, "utf8").split("\n").filter(line => /^(?:prompt|steer):/u.test(line)),
      ["prompt:hold", "steer:local-fake-hermes-fork:use the branch"]);
  } finally { await session.dispose(); }
});

test.each(["lost", "idle"])("Hermes does not claim injection when the native receipt is %s", async mode => {
  const logPath = path.join(scratch("oar-hermes-steer-receipt-"), "calls");
  const session = await open({}, { FAKE_HERMES_STEER: mode, FAKE_HERMES_CALL_LOG: logPath });
  try {
    const prompt = await session.prompt("hold");
    assert.equal(prompt.kind, "accepted");
    await expect.poll(() => readFileSync(logPath, "utf8")).toContain("prompt:hold");
    const result = await session.steerOrQueue("correction");
    assert.equal(result.landed, mode === "lost" ? "rejected" : "queued");
    assert.equal(readFileSync(logPath, "utf8").includes("prompt:correction"), false);
  } finally { await session.dispose(); }
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// oxlint-disable-next-line eslint/max-statements -- One open, one turn and the full assert set describe this mapping.
test("Hermes ACP profile opens the gateway's real session shape and maps a completed turn", async () => {
  const modelState = {
    currentModelId: "openrouter:provider/model-a",
    availableModels: [
      { modelId: "openrouter:provider/model-a", name: "Provider · Model A", description: "current" },
      { modelId: "openrouter:provider/model-b", name: "Provider · Model B" },
    ],
  };
  const session = await open({}, { FAKE_HERMES_MODELS: JSON.stringify(modelState) });
  assert.equal(session.id, "local-fake-hermes");
  assert.equal(typeof session.steer, "undefined");
  assert.equal(session.capabilities.images, true);
  assert.deepEqual(session.capabilities.queue, { durable: false });
  assert.equal(session.model().value, "openrouter:provider/model-a");

  const turn = await promptAndWait(session, "hello");
  assert.equal(turn.kind, "ended");
  assert.deepEqual(turn.outcome, { kind: "completed" });
  assert.deepEqual(session.contextUsage().value, { tokens: 300, contextWindow: 1000, percent: 30 });
  // `turn_usage` carries the gateway's session-cumulative counters; the
  // adapter does not map them as per-prompt tokens.
  assert.equal(session.usage().value.total, null);
  assert.ok(completedText(session).includes("echo:hello"));
  await session.dispose();
});

test("Hermes model and effort use the gateway's config selectors and read back the applied values", async () => {
  const log = path.join(scratch("oar-hermes-log-"), "calls.txt");
  const modelState = {
    currentModelId: "openrouter:provider/model-a",
    availableModels: [
      { modelId: "openrouter:provider/model-a", name: "Provider · Model A" },
      { modelId: "openrouter:provider/model-b", name: "Provider · Model B" },
    ],
  };
  const reopened = await acpSession({ ...hermesAcpProfile, args: [fixture] })(install, {
    cwd: process.cwd(),
    env: { FAKE_HERMES_MODELS: JSON.stringify(modelState), FAKE_HERMES_CALL_LOG: log },
    model: "openrouter:provider/model-b",
    effort: "high",
  });
  expect(reopened.model().value).toBe("openrouter:provider/model-b");
  expect(reopened.effort().value).toBe("high");
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "initialize",
    "session/new",
    "set_config_option:model=openrouter:provider/model-b",
    "set_config_option:reasoning_effort=high",
  ]);
  await reopened.dispose();
});

test("Hermes resume maps the gateway's not_found reason to SessionNotFoundError", async () => {
  const failure = { code: -32_603, message: "Internal error", data: { details: "not_found" } };
  await assert.rejects(
    acpSession({ ...hermesAcpProfile, args: [fixture] })(install, {
      cwd: process.cwd(),
      resume: "missing-hermes-session",
      env: { FAKE_HERMES_RESUME_ERROR: JSON.stringify(failure) },
    }),
    (error: unknown) => error instanceof SessionNotFoundError && error.sessionId === "missing-hermes-session",
  );
});

// oxlint-disable-next-line eslint/max-statements -- One exact readback and the associated wire assertions.
test("Hermes skips setters only for the exact applied model and effort", async () => {
  const log = path.join(scratch("oar-hermes-stable-selectors-"), "calls.txt");
  const model = "custom:hikari:deepseek-flash";
  const modelState = { currentModelId: model, availableModels: [{ modelId: model, name: model }] };
  const session = await open({}, { FAKE_HERMES_MODELS: JSON.stringify(modelState) });
  await session.dispose();
  const resumed = await acpSession({ ...hermesAcpProfile, args: [fixture] })(install, {
    cwd: process.cwd(),
    env: { FAKE_HERMES_MODELS: JSON.stringify(modelState), FAKE_HERMES_EFFORT: "high", FAKE_HERMES_CALL_LOG: log },
    resume: session.id,
    model,
    effort: "high",
  });
  try {
    expect(resumed.model().value).toBe(model);
    expect(resumed.effort().value).toBe("high");
    expect(readFileSync(log, "utf8")).not.toContain("set_config_option");
  } finally { await resumed.dispose(); }
});

test("Hermes listModels projects the gateway model state and falls back to config options", async () => {
  assert.deepEqual(projectHermesModels({
    models: {
      currentModelId: "openrouter:provider/model-a",
      availableModels: [
        { modelId: "openrouter:provider/model-a", name: "Provider · Model A" },
        { modelId: "openrouter:provider/model-b", name: "Provider · Model B" },
      ],
    },
  }), [
    { id: "openrouter:provider/model-a", displayName: "Provider · Model A", default: true },
    { id: "openrouter:provider/model-b", displayName: "Provider · Model B" },
  ]);
  assert.deepEqual(projectHermesModels({
    configOptions: [{
      id: "model", currentValue: "openrouter:provider/model-a",
      options: [{ value: "openrouter:provider/model-a", name: "Provider · Model A" }, { value: "openrouter:provider/model-b", name: "Provider · Model B" }],
    }],
  }), [
    { id: "openrouter:provider/model-a", displayName: "Provider · Model A", default: true },
    { id: "openrouter:provider/model-b", displayName: "Provider · Model B" },
  ]);
  assert.equal(projectHermesModels({}), undefined);

  const listingCommand = writeHermesWrapper(scratch("oar-hermes-listing-"), fixture);
  const listing = await hermesListModels(
    { kind: "available", via: "executable", command: listingCommand },
    {
      env: {
        FAKE_HERMES_MODELS: JSON.stringify({
          currentModelId: "openrouter:provider/model-a",
          availableModels: [{ modelId: "openrouter:provider/model-a", name: "Provider · Model A" }],
        }),
      },
    },
  );
  assert.deepEqual(listing, {
    kind: "ok",
    models: [{ id: "openrouter:provider/model-a", displayName: "Provider · Model A", default: true }],
  });
});

test("Hermes installation verifies acp --check and reads the version through OAR_HERMES_BIN", async () => {
  const { hermesInstallation } = await import("../../packages/oar/src/runtimes/hermes/installation.js");
  const bin = bareHermes();
  expect(await hermesInstallation({ env: { OAR_HERMES_BIN: bin, PATH: "" } })).toEqual({
    kind: "available",
    via: "executable",
    command: bin,
    version: "0.23.3",
  });
});

test("Hermes reuses the native readiness probe for the same environment", async () => {
  const { hermesInstallation } = await import("../../packages/oar/src/runtimes/hermes/installation.js");
  const log = path.join(scratch("oar-hermes-probe-"), "calls.txt");
  const env = { OAR_HERMES_BIN: bareHermes(), PATH: "", HERMES_TEST_LOG: log };
  const first = await hermesInstallation({ env });
  expect(first.kind).toBe("available");
  expect(await hermesInstallation({ env })).toEqual(first);
  expect(readFileSync(log, "utf8")).toBe("acp --check\n--version\n");
  await hermesInstallation({ env: { ...env, HERMES_HOME: path.dirname(log) } });
  expect(readFileSync(log, "utf8")).toBe("acp --check\n--version\nacp --check\n--version\n");
});
