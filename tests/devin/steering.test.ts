/* oxlint-disable max-statements -- Each case drives one native steer sequence end to end. */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { devinAcpProfile } from "../../packages/oar/src/runtimes/devin/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/index.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";

const tempDirs: string[] = [];
const fakeDevinScript = fileURLToPath(new URL("../fixtures/fake-acp-devin.mjs", import.meta.url));
const startFakeDevin = acpSession({ ...devinAcpProfile, args: [fakeDevinScript, "acp"] });
const fakeExecutable = { kind: "available", via: "executable", command: process.execPath } as const;

type StartedDevinSession = Awaited<ReturnType<typeof startFakeDevin>>;

function scratchDir(prefix: string): string {
  const raw = mkdtempSync(path.join(tmpdir(), prefix));
  const dir = realpathSync(raw);
  tempDirs.push(dir);
  return dir;
}

const until = async (check: () => boolean): Promise<void> => { await vi.waitFor(() => { expect(check()).toBe(true); }, { timeout: 5000, interval: 20 }); };
const textOf = (session: StartedDevinSession): string => session.records().flatMap((record) => record.kind === "frame"
  ? record.body.events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []) : []).join("");
const turnEnds = (session: StartedDevinSession): number => session.records().flatMap((record) => record.kind === "frame" && record.body.type === "session/prompt"
  ? record.body.events.filter((event) => event.kind === "turn_ended") : []).length;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("devin steers a running turn with a second session/prompt and folds it into one turn", async () => {
  const dir = scratchDir("oar-devin-steer-");
  const log = path.join(dir, "calls.txt");
  const session = await startFakeDevin(fakeExecutable, { cwd: dir, env: { FAKE_DEVIN_CALL_LOG: log } });
  try {
    const started = await session.prompt("hold");
    await until(() => readFileSync(log, "utf8").includes("session/prompt"));
    const steer = await session.steer?.("banana");
    expect(steer).toMatchObject({ kind: "accepted" });
    expect(await awaitTurnEnd(session, started.seq)).toMatchObject({ kind: "completed" });
    expect(readFileSync(log, "utf8")).toContain("steer:banana");
    // The steer joins the running turn: devin answers both prompts with that turn's result, once.
    expect(turnEnds(session)).toBe(1);
    expect(textOf(session)).toContain("took:banana");
  } finally {
    await session.dispose();
  }
});

test("devin has no steer when initialize does not advertise mid-turn prompts", async () => {
  const dir = scratchDir("oar-devin-no-steer-");
  const session = await startFakeDevin(fakeExecutable, { cwd: dir, env: { FAKE_DEVIN_MID_TURN_PROMPTS: "0" } });
  try {
    expect(session).not.toHaveProperty("steer");
  } finally {
    await session.dispose();
  }
});
