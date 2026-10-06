import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import { opencodeInstalledExecutableCandidates } from "../../packages/oar/src/runtimes/opencode/installation.js";
import { opencodeAcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { describe, fixture } from "../fixtures/acp-session-support.js";

// The fixture's "opencode" mode replays `opencode acp` 1.18.30: a prompt sent
// mid-turn joins the running loop and both prompts are answered at idle, and
// `session/list` names each session's own directory. The real profile runs
// against it, with only the launch line swapped for the fixture's.
function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return realpathSync(dir);
}

async function startOpencode(options: Partial<SessionOptions> = {}): Promise<Session> {
  return acpSession({ ...opencodeAcpProfile, args: [fixture, "opencode"] })(
    { kind: "available", via: "executable", command: process.execPath },
    { cwd: process.cwd(), ...options },
  );
}

function lines(session: Session): string[] {
  return session.records().map((record) => describe(record));
}

test("a steer joins the running turn, which ends once with both inputs answered", async () => {
  const session = await startOpencode();
  const prompted = await session.prompt("hold");
  expect(prompted.kind).toBe("accepted");
  const steered = await session.steer?.("more");
  expect(steered?.kind).toBe("accepted");
  expect(await awaitTurnEnd(session, prompted.seq)).toEqual({ kind: "completed" });
  expect(lines(session).filter((line) => line.includes("turn_ended"))).toEqual(["event session/prompt → turn_ended:completed"]);
  expect(lines(session)).toContain("event agent_message_chunk → text:merged:hold+more");
  await session.dispose();
});

test("an idle session has nothing to steer, and a plain prompt runs as usual", async () => {
  const session = await startOpencode();
  const early = await session.steer?.("too early");
  expect(early?.kind).toBe("rejected");
  const run = await promptAndWait(session, "hello");
  expect(run.kind === "ended" ? run.outcome : run).toEqual({ kind: "completed" });
  await session.dispose();
});

test("a resume is refused outside the session's own directory and opens inside it", async () => {
  const own = scratch("oar-opencode-own-");
  const other = scratch("oar-opencode-other-");
  const env = { FAKE_ACP_SESSION_CWD: own };
  await expect(startOpencode({ cwd: other, resume: "fake-session", env })).rejects.toMatchObject({
    name: "UnsupportedOptionError",
    option: "cwd",
  });
  const session = await startOpencode({ cwd: own, resume: "fake-session", env });
  expect(session.id).toBe("fake-session");
  await session.dispose();
});

test("a model switch goes through its config option, whose answer carries that model's effort menu", async () => {
  const session = await startOpencode({ model: "requested-y", effort: "high" });
  expect(lines(session)).toContain("event session/set_config_option → model:requested-y, effort:medium");
  expect(session.effort().value).toBe("high");
  await session.dispose();
  // Without the switch the open model's menu is read, and it has none.
  await expect(startOpencode({ effort: "high" })).rejects.toThrow("session/new advertises no thought_level config option, so effort high cannot be applied");
});

test("the opencode profile opens without authenticate and refuses a system prompt", async () => {
  const session = await startOpencode();
  expect(lines(session)).not.toContain("event authenticate");
  expect(session.capabilities).toMatchObject({ queue: { durable: false }, attribution: "opaque" });
  await session.dispose();
  expect(() => opencodeAcpProfile.validateOptions?.({ cwd: "/", systemPrompt: "x" })).toThrow();
  expect(() => opencodeAcpProfile.validateOptions?.({ cwd: "/", appendSystemPrompt: "x" })).toThrow();
  expect(() => opencodeAcpProfile.validateOptions?.({ cwd: "/", env: { A: "1" } })).not.toThrow();
});

test("the install script's directory is a fallback on each platform", () => {
  expect(opencodeInstalledExecutableCandidates("linux", "/home/u")).toEqual(["/home/u/.opencode/bin/opencode"]);
  expect(opencodeInstalledExecutableCandidates("win32", String.raw`C:\Users\u`)).toEqual([String.raw`C:\Users\u\.opencode\bin\opencode.exe`]);
});
