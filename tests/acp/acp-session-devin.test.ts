import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { UnsupportedOptionError } from "../../packages/oar/src/index.js";
import {
  devinAcpArgs,
  devinAcpProfile,
  devinSession,
  supportsDevinBypass,
} from "../../packages/oar/src/runtimes/devin/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { describe } from "../fixtures/acp-session-support.js";

type DevinSessionOptions = Parameters<typeof devinSession>[1];
type StartedDevinSession = Awaited<ReturnType<typeof devinSession>>;

const tempDirs: string[] = [];
const fakeDevinScript = fileURLToPath(new URL("../fixtures/fake-acp-devin.mjs", import.meta.url));
const startFakeDevin = acpSession({ ...devinAcpProfile, args: [fakeDevinScript, "acp"] });
const fakeExecutable = { kind: "available", via: "executable", command: process.execPath } as const;

function scratchDir(prefix: string): string {
  const raw = mkdtempSync(path.join(tmpdir(), prefix));
  const dir = realpathSync(raw);
  tempDirs.push(dir);
  return dir;
}

function readCalls(log: string): readonly string[] {
  return readFileSync(log, "utf8").trim().split("\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supportsDevinBypass checks modes.availableModes and configOptions mode selector", () => {
  expect(supportsDevinBypass({ modes: { availableModes: [{ id: "accept-edits" }, { id: "bypass" }] } })).toBe(true);
  expect(supportsDevinBypass({ modes: { availableModes: [{ id: "accept-edits" }, { id: "plan" }] } })).toBe(false);
  expect(supportsDevinBypass({ configOptions: [{ id: "mode", options: [{ value: "accept-edits" }, { value: "bypass" }] }] })).toBe(true);
  expect(supportsDevinBypass({ configOptions: [{ id: "mode", options: [{ value: "accept-edits" }] }] })).toBe(false);
  expect(supportsDevinBypass({})).toBe(false);
});

async function withDevinSession(options: DevinSessionOptions, check: (session: StartedDevinSession) => Promise<void> | void): Promise<void> {
  const session = await startFakeDevin(fakeExecutable, options);
  try {
    await check(session);
  } finally {
    await session.dispose();
  }
}

test.each([true, false])("devin session sets bypass mode only when advertised (advertised=%s)", async (advertiseBypass) => {
  const dir = scratchDir("oar-devin-bypass-");
  const log = path.join(dir, "calls.txt");
  await withDevinSession(
    { cwd: dir, env: { FAKE_DEVIN_CALL_LOG: log, FAKE_DEVIN_ADVERTISE_BYPASS: advertiseBypass ? "1" : "0" } },
    async (session) => {
      const run = await promptAndWait(session, "check");
      expect(run).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      const text = session.records().map((record) => describe(record)).findLast((line) => line.startsWith("event agent_message_chunk"));
      expect(text).toBe(advertiseBypass ? "event agent_message_chunk → text:mode:bypass" : "event agent_message_chunk → text:mode:accept-edits");
      expect(readCalls(log).includes("session/set_mode")).toBe(advertiseBypass);
    },
  );
});

test("devin switches model and effort via session/set_config_option rather than session/set_model", async () => {
  const dir = scratchDir("oar-devin-model-");
  const log = path.join(dir, "calls.txt");
  await withDevinSession(
    { cwd: dir, model: "gpt-5", effort: "high", env: { FAKE_DEVIN_CALL_LOG: log, FAKE_DEVIN_ADVERTISE_BYPASS: "1" } },
    (session) => {
      expect(session.model().value).toBe("gpt-5");
      expect(session.effort().value).toBe("high");
      const calls = readCalls(log);
      expect(calls).not.toContain("session/set_model");
      expect(calls.filter((line) => line === "session/set_config_option")).toHaveLength(2);
      const opening = session.records().map((record) => describe(record));
      expect(opening).toContain("event session/set_config_option → model:gpt-5, effort:medium");
      expect(opening).toContain("event session/set_config_option → model:gpt-5, effort:high");
    },
  );
});

test("devin refuses cross-directory resume before session/load", async () => {
  const dirA = scratchDir("oar-devin-dir-a-");
  const dirB = scratchDir("oar-devin-dir-b-");
  const log = path.join(dirA, "calls.txt");
  const refused = startFakeDevin(fakeExecutable, {
    cwd: dirB,
    resume: "devin-sess-1",
    env: { FAKE_DEVIN_CALL_LOG: log, FAKE_DEVIN_SESSION_CWD: dirA },
  });
  await expect(refused).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(refused).rejects.toMatchObject({ option: "cwd" });
  expect(readCalls(log)).toEqual(["initialize", "session/list"]);
});

test("devin allows same-directory resume via session/load", async () => {
  const dirA = scratchDir("oar-devin-same-dir-");
  const log = path.join(dirA, "calls.txt");
  writeFileSync(log, "");
  const resumed = await startFakeDevin(fakeExecutable, {
    cwd: dirA,
    resume: "devin-sess-1",
    env: { FAKE_DEVIN_CALL_LOG: log, FAKE_DEVIN_SESSION_CWD: dirA },
  });
  try {
    expect(resumed.id).toBe("devin-sess-1");
    expect(readCalls(log)).toContain("session/load");
  } finally {
    await resumed.dispose();
  }
});

test("devin refuses unsupported session options with UnsupportedOptionError before spawning", async () => {
  expect(devinAcpArgs()).toEqual(["--permission-mode", "dangerous", "--respect-workspace-trust", "false", "acp"]);
  const installation = { kind: "available", via: "executable", command: "/nonexistent/devin" } as const;
  const refusedCases: readonly { readonly option: string; readonly extra: Partial<DevinSessionOptions> }[] = [
    { option: "additionalDirectories", extra: { additionalDirectories: ["/extra"] } },
    { option: "appendSystemPrompt", extra: { appendSystemPrompt: "append" } },
    { option: "disallowedTools", extra: { disallowedTools: ["Bash"] } },
    { option: "endTurnProcessesOnAbort", extra: { endTurnProcessesOnAbort: true } },
    { option: "goals", extra: { goals: true } },
    { option: "name", extra: { name: "session-name" } },
    { option: "outputSchema", extra: { outputSchema: { type: "object" } } },
    { option: "serviceTier", extra: { serviceTier: "fast" } },
    { option: "systemPrompt", extra: { systemPrompt: "replace" } },
    { option: "userConfiguration", extra: { userConfiguration: "exclude" } },
  ];
  await Promise.all(refusedCases.map(async ({ option, extra }) => {
    await expect(devinSession(installation, { cwd: "/tmp", ...extra })).rejects.toMatchObject({
      name: "UnsupportedOptionError",
      option,
    });
  }));
});
