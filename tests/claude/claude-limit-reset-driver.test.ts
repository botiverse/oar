/* oxlint-disable eslint/max-lines, eslint/max-statements, eslint/no-await-in-loop -- Recorded-screen scenarios: each test follows its attempts from start to end, one at a time on the shared fake clock. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

import {
  CLAUDE_DIALOG_KEY_GUARD_MS,
  CLAUDE_REDEEM_MIN_SUBMIT_MS,
  claudeFiveHourLimitOf,
  createClaudeLimitResetDriver,
  type ClaudeFiveHourLimit,
  type ClaudeLimitResetDeps,
  type ClaudeLimitResetRedeemInput,
  type ClaudeLimitResetsReadInput,
} from "../../packages/oar/src/runtimes/claude/limit-reset/driver.js";
import { promptInput, type ClaudeLimitResetKind as RuntimeLimitResetKind } from "../../packages/oar/src/runtimes/claude/limit-reset/screens.js";
import type { OpenClaudeLimitResetTerminal } from "../../packages/oar/src/shared/executable/script-terminal.js";

// Every screen here is one Claude Code 2.1.322 drew in the offline harness
// (fake account, fake backend). `claude` is never started by these tests: the
// driver talks to FakeClaude, which replays those screens and records keys.
const FIXTURES = path.join(import.meta.dirname, "limit-reset-fixtures");
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8").replace(/\n+$/u, "");

const KEY = "0f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f";
const OTHER_KEY = "1f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f";
const ENTER = "\r";
const ESCAPE = "\u001B";
const ARROW_DOWN = "\u001B[B";
/** Claude Code drops keys that arrive this soon after a dialog opens. */
const TUI_KEY_IGNORE_MS = 250;
const KIND_ARGS: Record<RuntimeLimitResetKind, string> = { five_hour: "5-hour", weekly: "weekly", fable: "fable", full: "full" };

interface CommandScript {
  /** The fixture the command leads to. */
  shows: string;
  /** How long the command takes to show it (40 ms unless said). */
  afterMs?: number;
  /** Painted a piece at a time, this many ms apart, then once more in full: a slow, repainting terminal. */
  paintedEveryMs?: number;
  /** The command the fixture was recorded with, when it is replayed for another one. */
  recordedWith?: string;
  /** That fixture is a dialog; these are what Enter and Esc on it lead to. */
  dialog?: { afterEnter?: string; afterEscape?: string };
}

type Mode = "starting" | "trust" | "prompt" | "dialog" | "busy" | "exited";

class FakeClaude {
  readonly writes: { data: string; during: Mode }[] = [];
  spawns = 0;
  /** Sessions the driver ended by killing them (the only way it ends one). */
  kills = 0;
  /** When the screen was last painted. */
  paintedAt = 0;
  /** Enter presses a dialog accepted (past its key-ignore window). */
  dialogEnters = 0;
  private mode: Mode = "starting";
  private screen = "";
  private input = "";
  private trustYesSelected = false;
  private dialogOpenedAt = 0;
  private openDialog: CommandScript["dialog"];
  private onData: (chunk: string) => void = () => {};
  private readonly exitListeners: (() => void)[] = [];

  constructor(private readonly script: {
    /** The first screen: `trust`, `prompt`, `sign-in`, or nothing at all (`silent`). */
    startsAt?: "trust" | "prompt" | "sign-in" | "silent";
    commands?: Record<string, CommandScript | "never">;
    /** How long a claim takes after Yes. */
    afterEnterMs?: number;
    /** What the input box shows for what was typed: a terminal that loses keystrokes. */
    garble?: (typed: string) => string;
    /** How long the first screen takes (200 ms unless said). */
    startsAfterMs?: number;
    /** Synthetic changes applied to recorded screens before painting. */
    screenText?: (text: string, mode: Mode) => string;
  } = {}) {}

  readonly open: OpenClaudeLimitResetTerminal = () => {
    this.spawns += 1;
    this.mode = "starting";
    this.input = "";
    const startsAt = this.script.startsAt ?? "trust";
    if (startsAt !== "silent") { setTimeout(() => { this.show(startsAt, startsAt === "trust" ? "trust" : "prompt"); }, this.script.startsAfterMs ?? 200); }
    return {
      write: (data) => { this.write(data); },
      onData: (listener) => { this.onData = listener; },
      onExit: (listener) => { this.exitListeners.push(listener); },
      kill: async () => {
        if (this.mode !== "exited") { this.kills += 1; }
        this.exit();
      },
    };
  };

  /** Everything written, as one string. */
  keys(): string {
    return this.writes.map((write) => write.data).join("");
  }

  enters(during: Mode): number {
    return this.writes.filter((write) => write.data === ENTER && write.during === during).length;
  }

  private exit(): void {
    if (this.mode === "exited") { return; }
    this.mode = "exited";
    for (const listener of this.exitListeners) { listener(); }
  }

  private show(name: string, mode: Mode): void {
    if (this.mode === "exited") { return; }
    this.screen = fixture(name);
    this.mode = mode;
    if (mode === "dialog") { this.dialogOpenedAt = Date.now(); }
    this.paint();
  }

  private paint(): void {
    let text = this.screen;
    if (this.mode === "trust" && this.trustYesSelected) {
      text = text.replace(" ❯ No, exit\n   Yes, I trust this folder", "   No, exit\n ❯ Yes, I trust this folder");
    }
    if (this.mode === "prompt") { text = text.replace(/^❯\u00A0$/mu, `❯\u00A0${this.input && this.script.garble ? this.script.garble(this.input) : this.input}`); }
    text = this.script.screenText?.(text, this.mode) ?? text;
    this.emit(`\u001B[2J\u001B[H${text.split("\n").join("\r\n")}`);
  }

  private emit(output: string): void {
    if (this.mode === "exited") { return; }
    this.paintedAt = Date.now();
    this.onData(output);
  }

  /** The dialog a piece at a time (pieces cut anywhere, escape sequences included), then a full repaint. */
  private showSlowly(name: string, everyMs: number): void {
    this.screen = fixture(name);
    this.mode = "dialog";
    this.dialogOpenedAt = Date.now();
    const output = `\u001B[2J\u001B[H${this.screen.split("\n").map((line) => `\u001B[0m${line}`).join("\r\n")}`;
    const pieces = output.match(/[\s\S]{1,37}/gu) ?? [];
    pieces.forEach((piece, index) => { setTimeout(() => { this.emit(piece); }, index * everyMs); });
    setTimeout(() => { this.emit("\u001B[2J"); }, pieces.length * everyMs + 300);
    setTimeout(() => { this.paint(); }, pieces.length * everyMs + 350);
  }

  // oxlint-disable-next-line eslint/max-lines-per-function -- One fake keyboard: what each mode does with a key, in one place.
  private write(data: string): void {
    this.writes.push({ data, during: this.mode });
    switch (this.mode) {
      case "trust":
        if (data === ARROW_DOWN) {
          this.trustYesSelected = true;
          this.paint();
        } else if (data === ENTER) {
          if (this.trustYesSelected) { setTimeout(() => { this.show("prompt", "prompt"); }, 300); }
          else { this.exit(); }
        }
        return;
      case "prompt": {
        if (data === ESCAPE) { return; }
        if (data !== ENTER) {
          this.input += data;
          this.paint();
          return;
        }
        const command = this.input;
        this.input = "";
        const script = this.script.commands?.[command] ?? { shows: "unknown-command" };
        this.mode = "busy";
        if (script === "never") { return; }
        this.openDialog = script.dialog;
        setTimeout(() => {
          if (script.paintedEveryMs !== undefined && script.paintedEveryMs !== 0) {
            this.showSlowly(script.shows, script.paintedEveryMs);
            return;
          }
          this.show(script.shows, script.dialog ? "dialog" : "prompt");
          if (script.recordedWith !== undefined && script.recordedWith !== "") {
            this.screen = this.screen.replace(`❯ ${script.recordedWith}`, `❯ ${command}`);
            this.paint();
          }
        }, script.afterMs ?? 40);
        return;
      }
      case "dialog": {
        if (Date.now() - this.dialogOpenedAt < TUI_KEY_IGNORE_MS) { return; }
        const dialog = this.openDialog ?? {};
        const { afterEnter } = dialog;
        if (data === ENTER) {
          this.dialogEnters += 1;
          this.mode = "busy";
          if (afterEnter !== undefined && afterEnter !== "") { setTimeout(() => { this.show(afterEnter, "prompt"); }, this.script.afterEnterMs ?? 80); }
        } else if (data === ESCAPE) {
          this.show(dialog.afterEscape ?? "prompt", "prompt");
        }
        break;
      }
      case "starting":
      case "busy":
      case "exited":
        break;
    }
  }
}

/** An override set to `undefined` removes that dependency (a driver built without it). */
type Overrides = { [Key in keyof ClaudeLimitResetDeps]?: ClaudeLimitResetDeps[Key] | undefined };

function withOverrides(base: ClaudeLimitResetDeps, overrides: Overrides): ClaudeLimitResetDeps {
  const deps: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) { delete deps[key]; } else { deps[key] = value; }
  }
  return deps;
}

function driverFor(claude: FakeClaude, overrides: Overrides = {}) {
  const probes = { fiveHourChecks: 0 };
  const inner = createClaudeLimitResetDriver(withOverrides({
    platform: "linux",
    cachedFlags: async () => ({ limitResets: true }),
    fiveHourLimit: async () => {
      probes.fiveHourChecks += 1;
      return "not_at_limit";
    },
    openTerminal: claude.open,
    workDir: async () => ({ path: "/nonexistent/claude-limit-reset", remove: async () => {} }),
  }, overrides));
  const command = "/usr/local/bin/claude";
  const driver = {
    // oxlint-disable-next-line typescript/promise-function-async -- The driver's own promise, so a retry's answer can be checked to be the same one.
    redeem: (input: Omit<ClaudeLimitResetRedeemInput, "command">) => inner.redeem({ command, env: {}, ...input }),
    // oxlint-disable-next-line typescript/promise-function-async -- As redeem.
    read: (input: Omit<ClaudeLimitResetsReadInput, "command">) => inner.read({ command, env: {}, ...input }),
  };
  return { driver, probes };
}

/** Lets a driver call run to its end under fake timers. */
async function finish<T>(running: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(180_000);
  return running;
}

const confirmFor = (kind: RuntimeLimitResetKind): Record<string, CommandScript> => ({
  [`/limit-reset ${KIND_ARGS[kind]}`]: { shows: `confirm-${kind}`, dialog: { afterEnter: `reset-${kind}`, afterEscape: "prompt" } },
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

for (const kind of ["five_hour", "weekly", "fable", "full"] as const) {
  test(`redeem ${kind}: the command names the kind, Yes is sent once, after the key guard`, async () => {
    const claude = new FakeClaude({ commands: confirmFor(kind) });
    const { driver } = driverFor(claude);
    let dialogSeenAt = 0;
    let yesAt = 0;
    const running = driver.redeem({ kind, idempotencyKey: KEY });
    const stopWatching = setInterval(() => {
      const last = claude.writes.at(-1);
      if (!dialogSeenAt && last?.data === ENTER && last.during === "prompt") { dialogSeenAt = Date.now() + 40; }
      if (!yesAt && claude.dialogEnters === 1) { yesAt = Date.now(); }
    }, 1);
    const report = await finish(running);
    clearInterval(stopWatching);

    assert.deepEqual(report, { result: { kind: "reset" }, claudeVersion: "2.1.322" });
    assert.equal(claude.keys(), `${ARROW_DOWN}${ENTER}/limit-reset ${KIND_ARGS[kind]}${ENTER}${ENTER}`);
    assert.equal(claude.enters("dialog"), 1, "one Enter while the dialog was open");
    assert.equal(claude.dialogEnters, 1, "and Claude Code took it");
    assert.ok(yesAt - dialogSeenAt >= CLAUDE_DIALOG_KEY_GUARD_MS, `Yes ${yesAt - dialogSeenAt} ms after the dialog opened`);
    assert.equal(claude.spawns, 1);
    assert.equal(claude.kills, 1, "the session is ended by killing it, never by typing");
  });
}

test("the key guard is at least 600 ms", () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- Guards the constant itself: this fails if it is ever lowered.
  assert.ok(CLAUDE_DIALOG_KEY_GUARD_MS >= 600);
});

test("a folder Claude Code already trusts goes straight to the prompt", async () => {
  const claude = new FakeClaude({ startsAt: "prompt", commands: confirmFor("weekly") });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "weekly", idempotencyKey: KEY }));
  assert.deepEqual(report.result, { kind: "reset" });
  assert.equal(claude.keys(), `/limit-reset weekly${ENTER}${ENTER}`);
});

test("a picker instead of the confirmation: Esc, no Yes, unknown", async () => {
  const claude = new FakeClaude({ commands: { "/limit-reset weekly": { shows: "picker", dialog: { afterEnter: "reset-weekly" } } } });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "weekly", idempotencyKey: KEY }));
  assert.deepEqual(report, { result: { kind: "unknown" }, step: "dialog", claudeVersion: "2.1.322" });
  assert.equal(claude.enters("dialog"), 0);
  assert.equal(claude.writes.filter((write) => write.data === ESCAPE && write.during === "dialog").length, 1);
});

test("a dialog that names another kind: Esc, no Yes, unknown", async () => {
  const claude = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows: "confirm-weekly", dialog: { afterEnter: "reset-weekly" } } } });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report, { result: { kind: "unknown" }, step: "dialog", claudeVersion: "2.1.322" });
  assert.equal(claude.enters("dialog"), 0);
  assert.equal(claude.writes.filter((write) => write.data === ESCAPE && write.during === "dialog").length, 1);
});

test("a dialog whose effect line or count line is not the recorded one: Esc, no Yes, unknown", async () => {
  // Synthetic: what Yes would do changed under a newer banner; the Yes row and title did not.
  for (const shows of ["altered-effect-five_hour", "no-count-five_hour"]) {
    const claude = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows, dialog: { afterEnter: "reset-five_hour" } } } });
    const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
    assert.deepEqual(report.result, { kind: "unknown" }, shows);
    assert.equal(claude.enters("dialog"), 0, shows);
    assert.equal(claude.dialogEnters, 0, shows);
  }
});

test("the early-use warning is part of the recorded dialog: Yes goes", async () => {
  const claude = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows: "early-use-five_hour", dialog: { afterEnter: "reset-five_hour" } } } });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report.result, { kind: "reset" });
  assert.equal(claude.dialogEnters, 1);
});

test("a dialog whose Yes row is not the recorded one: Esc, no Yes, unknown", async () => {
  const claude = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows: "relabelled-dialog", dialog: { afterEnter: "reset-five_hour" } } } });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report.result, { kind: "unknown" });
  assert.equal(claude.enters("dialog"), 0);
  assert.ok(claude.keys().includes(ESCAPE));
});

test("no reset to use, or none of that kind: no_reset, and nothing but the command is typed", async () => {
  for (const shows of ["none", "kind-not-held"]) {
    const claude = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows } } });
    const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
    assert.deepEqual(report, { result: { kind: "no_reset" }, claudeVersion: "2.1.322" }, shows);
    assert.equal(claude.keys(), `${ARROW_DOWN}${ENTER}/limit-reset 5-hour${ENTER}`, shows);
  }
});

test("a reset saved for a limit the account is not at: nothing_to_reset", async () => {
  const claude = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows: "needs-limit" } } });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report.result, { kind: "nothing_to_reset" });
});

test("Claude Code has no /limit-reset for this account: unsupported", async () => {
  const claude = new FakeClaude({ commands: {} });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report, { result: { kind: "unsupported", reason: "endpoint_unavailable" }, step: "command", claudeVersion: "2.1.322" });
});

test("the older program, 5-hour click: its line without a dialog is the answer", async () => {
  const spent = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows: "legacy-reset" } } });
  const spentReport = await finish(driverFor(spent).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(spentReport.result, { kind: "reset" });
  assert.equal(spent.enters("dialog"), 0);

  const unavailable = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows: "legacy-unavailable" } } });
  // "isn't available right now" may only mean the account is not at the 5-hour limit yet: not "holds none".
  const unavailableReport = await finish(driverFor(unavailable).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(unavailableReport.result, { kind: "nothing_to_reset" });
  assert.equal(unavailable.keys().split("/limit-reset").length - 1, 1, "one attempt");
});

test("the older program, any other kind: refused unless the cached flags say the newer program is on", async () => {
  for (const limitResets of [false, null]) {
    const claude = new FakeClaude();
    const { driver } = driverFor(claude, { cachedFlags: async () => ({ limitResets }) });
    const report = await finish(driver.redeem({ kind: "weekly", idempotencyKey: KEY }));
    assert.deepEqual(report, { result: { kind: "unsupported", reason: "consent_required" }, step: "flags" });
    assert.equal(claude.spawns, 0);
  }
  // The cache said on, Claude Code answered as the older program anyway.
  const stale = new FakeClaude({ commands: { "/limit-reset weekly": { shows: "legacy-unavailable", recordedWith: "/limit-reset 5-hour" } } });
  const staleReport = await finish(driverFor(stale).driver.redeem({ kind: "weekly", idempotencyKey: KEY }));
  assert.deepEqual(staleReport.result, { kind: "no_reset" });
  // And if it spent its 5-hour reset for a weekly click, that is not a weekly reset.
  const spent = new FakeClaude({ commands: { "/limit-reset weekly": { shows: "legacy-reset", recordedWith: "/limit-reset 5-hour" } } });
  const spentReport = await finish(driverFor(spent).driver.redeem({ kind: "weekly", idempotencyKey: KEY }));
  assert.deepEqual(spentReport.result, { kind: "unknown", fiveHourSpent: true }, "not a weekly reset, and it says what was spent");
  assert.equal(spent.keys().split("/limit-reset").length - 1, 1, "never a second attempt");
});

test("a screen never seen at startup: no Enter, no command, not attempted, and the process is ended", async () => {
  const claude = new FakeClaude({ startsAt: "silent" });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report, { result: { kind: "not_attempted", reason: "startup_failed" }, step: "startup" });
  assert.equal(claude.keys(), "");
  assert.equal(claude.kills, 1);
});

test("not signed in: reauth_required, and nothing is typed", async () => {
  const claude = new FakeClaude({ startsAt: "sign-in" });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report, { result: { kind: "reauth_required", reason: "not_authenticated" }, step: "sign_in" });
  assert.equal(claude.keys(), "");
  assert.equal(claude.kills, 1);
});

test("the command never answers: no Yes, Esc only, unknown, and the process is ended", async () => {
  const claude = new FakeClaude({ commands: { "/limit-reset 5-hour": "never" } });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report, { result: { kind: "unknown" }, step: "command", claudeVersion: "2.1.322" });
  assert.equal(claude.keys(), `${ARROW_DOWN}${ENTER}/limit-reset 5-hour${ENTER}${ESCAPE}`);
  assert.equal(claude.dialogEnters, 0);
  assert.equal(claude.kills, 1);
});

test("with less than the claim window left, Yes is not sent: Esc, the reset is kept, and the same click may try again", async () => {
  // Submitted 3.6 s in with 50.2 s left (enough), but the dialog takes 19.8 s and has held still at 24 s: 29.8 s left, under the claim window.
  const claude = new FakeClaude({ startsAt: "prompt", commands: { "/limit-reset 5-hour": { shows: "confirm-five_hour", afterMs: 19_800, dialog: { afterEnter: "reset-five_hour", afterEscape: "kept-five_hour" } } } });
  const timeoutMs = CLAUDE_REDEEM_MIN_SUBMIT_MS + 3800;
  const { driver } = driverFor(claude, { timeoutMs });
  const report = await finish(driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report, { result: { kind: "not_attempted", reason: "deadline" }, step: "confirm", claudeVersion: "2.1.322" });
  assert.equal(claude.enters("dialog"), 0);
  assert.equal(claude.keys(), `/limit-reset 5-hour${ENTER}${ESCAPE}`);
  await finish(driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.equal(claude.spawns, 2, "nothing was spent, so the key is not held");

  // Esc that does not lead to the "kept" line: whether it was kept is not known.
  const unclear = new FakeClaude({ startsAt: "prompt", commands: { "/limit-reset 5-hour": { shows: "confirm-five_hour", afterMs: 19_800, dialog: { afterEscape: "prompt" } } } });
  const unclearReport = await finish(driverFor(unclear, { timeoutMs }).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(unclearReport.result, { kind: "unknown" });
  assert.equal(unclear.enters("dialog"), 0);
});

test("too little left right before the command is submitted: nothing typed, not_attempted, and the key is not held", async () => {
  // A short budget: the start check passes, but at the prompt there is far less than the claim window plus the command's time.
  const claude = new FakeClaude({ startsAt: "prompt", commands: confirmFor("five_hour") });
  const { driver } = driverFor(claude, { timeoutMs: 4000 });
  const report = await finish(driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report, { result: { kind: "not_attempted", reason: "deadline" }, step: "budget", claudeVersion: "2.1.322" });
  assert.equal(claude.keys(), "", "on the older program the submission alone would spend the 5-hour reset");
  assert.equal(claude.kills, 1);
  await finish(driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.equal(claude.spawns, 2, "nothing was done, so the same click may try again");

  // The full budget, eaten by a slow start and the folder-trust screen: 45.5 s left at the prompt, under the 50 s needed.
  const slow = new FakeClaude({ startsAfterMs: 25_000, commands: confirmFor("five_hour") });
  const slowReport = await finish(driverFor(slow).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(slowReport, { result: { kind: "not_attempted", reason: "deadline" }, step: "budget", claudeVersion: "2.1.322" });
  assert.equal(slow.keys(), `${ARROW_DOWN}${ENTER}`, "the trust screen only; no command");
  assert.equal(slow.dialogEnters, 0);

  // A read with too little left for one command is not attempted either.
  const read = new FakeClaude({ startsAt: "prompt", commands: READ_ALL });
  const readReport = await finish(driverFor(read, { timeoutMs: 4000 }).driver.read({ atFiveHourLimit: false }));
  assert.deepEqual(readReport, { result: { kind: "not_attempted", reason: "deadline" }, step: "budget", claudeVersion: "2.1.322" });
  assert.equal(read.keys(), "");
});

test("a dialog that opens after the command timed out gets Esc only: no Enter is ever written again", async () => {
  // The command times out 20 s after it was submitted; the dialog opens 500 ms later, while Esc is on its way.
  const claude = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows: "confirm-five_hour", afterMs: 20_500, dialog: { afterEnter: "reset-five_hour" } } } });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report, { result: { kind: "unknown" }, step: "command", claudeVersion: "2.1.322" });
  assert.equal(claude.keys(), `${ARROW_DOWN}${ENTER}/limit-reset 5-hour${ENTER}${ESCAPE}`);
  assert.equal(claude.enters("dialog"), 0);
  assert.equal(claude.dialogEnters, 0);
  assert.equal(claude.kills, 1, "ended by a kill, with the dialog still open");

  const read = new FakeClaude({ commands: { "/limit-reset weekly": { shows: "read-confirm-weekly", afterMs: 20_500, dialog: { afterEnter: "reset-weekly" } } } });
  const readReport = await finish(driverFor(read).driver.read({ atFiveHourLimit: false }));
  assert.ok(readReport.result.kind === "inspected");
  assert.deepEqual(readReport.result.resets.map((reset) => reset.state), ["not_checked", "unknown", "unknown", "unknown"]);
  assert.equal(read.keys(), `${ARROW_DOWN}${ENTER}/limit-reset weekly${ENTER}${ESCAPE}`);
  assert.equal(read.dialogEnters, 0);
});

/** A usage reader that answers `answer`, and notes what had been typed when it was asked. */
function fiveHourReader(claude: FakeClaude, answer: () => Promise<ClaudeFiveHourLimit>) {
  const asked: string[] = [];
  // oxlint-disable-next-line typescript/promise-function-async -- Hands on the answer's own promise.
  return { asked, fiveHourLimit: () => { asked.push(claude.keys()); return answer(); } };
}

test("a stale 'not at the 5-hour limit': usage is read again right before the command; at the limit now, nothing is typed", async () => {
  // A read: the server said not at the limit, but the account is there now. On the older program the command alone would spend.
  const claude = new FakeClaude({ commands: { "/limit-reset weekly": { shows: "legacy-reset", recordedWith: "/limit-reset 5-hour" } } });
  const reader = fiveHourReader(claude, async () => "at_limit");
  const report = await finish(driverFor(claude, { fiveHourLimit: reader.fiveHourLimit }).driver.read({ atFiveHourLimit: false }));
  assert.deepEqual(report, { result: { kind: "unsupported", reason: "consent_required" }, step: "usage", claudeVersion: "2.1.322" });
  assert.deepEqual(reader.asked, [`${ARROW_DOWN}${ENTER}`], "asked once, at the prompt, after startup and before any command");
  assert.ok(!claude.keys().includes("/limit-reset"));
  assert.equal(claude.kills, 1);

  // A redeem of another kind than the 5-hour one: the same check; nothing spent, so the key is not held.
  const redeem = new FakeClaude({ commands: { "/limit-reset weekly": { shows: "legacy-reset", recordedWith: "/limit-reset 5-hour" } } });
  const redeemReader = fiveHourReader(redeem, async () => "at_limit");
  const { driver } = driverFor(redeem, { fiveHourLimit: redeemReader.fiveHourLimit });
  const redeemReport = await finish(driver.redeem({ kind: "weekly", idempotencyKey: KEY }));
  assert.deepEqual(redeemReport, { result: { kind: "unsupported", reason: "consent_required" }, step: "usage", claudeVersion: "2.1.322" });
  assert.ok(!redeem.keys().includes("/limit-reset"));
  await finish(driver.redeem({ kind: "weekly", idempotencyKey: KEY }));
  assert.equal(redeem.spawns, 2);
});

test("usage that cannot be read right before the command: not_attempted, nothing typed", async () => {
  const unreadable: (() => Promise<ClaudeFiveHourLimit>)[] = [
    async () => "unknown",
    async () => { throw new Error("collector failed"); },
    // Never answers: given up on after a bounded wait.
    // oxlint-disable-next-line promise/avoid-new, typescript/promise-function-async -- A promise that never settles.
    () => new Promise<ClaudeFiveHourLimit>(() => {}),
  ];
  for (const answer of unreadable) {
    const read = new FakeClaude({ commands: READ_ALL });
    const readReport = await finish(driverFor(read, { fiveHourLimit: answer }).driver.read({ atFiveHourLimit: false }));
    assert.deepEqual(readReport, { result: { kind: "not_attempted", reason: "usage_unread" }, step: "usage", claudeVersion: "2.1.322" });
    assert.ok(!read.keys().includes("/limit-reset"));

    const redeem = new FakeClaude({ commands: confirmFor("fable") });
    const redeemReport = await finish(driverFor(redeem, { fiveHourLimit: answer }).driver.redeem({ kind: "fable", idempotencyKey: KEY }));
    assert.deepEqual(redeemReport.result, { kind: "not_attempted", reason: "usage_unread" });
    assert.equal(redeem.dialogEnters, 0);
    assert.ok(!redeem.keys().includes("/limit-reset"));
  }
  // No reader at all (a driver built without one) is the same as one that cannot read.
  const bare = new FakeClaude({ commands: READ_ALL });
  const bareReport = await finish(driverFor(bare, { fiveHourLimit: undefined }).driver.read({ atFiveHourLimit: false }));
  assert.deepEqual(bareReport.result, { kind: "not_attempted", reason: "usage_unread" });
});

test("the fresh usage check: once per read, never for a 5-hour redeem, and not when the person consented", async () => {
  const read = new FakeClaude({ commands: READ_ALL });
  const reading = driverFor(read);
  const readReport = await finish(reading.driver.read({ atFiveHourLimit: false, includeFiveHour: true }));
  assert.equal(readReport.result.kind, "inspected");
  assert.equal(reading.probes.fiveHourChecks, 1, "before the first command only: on the older program that is the only one");

  const fiveHour = new FakeClaude({ commands: confirmFor("five_hour") });
  const spending = driverFor(fiveHour);
  const spendingReport = await finish(spending.driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(spendingReport.result, { kind: "reset" });
  assert.equal(spending.probes.fiveHourChecks, 0, "spending the 5-hour reset is what was clicked");

  const consented = new FakeClaude({ commands: READ_ALL });
  const knowing = driverFor(consented);
  const knowingReport = await finish(knowing.driver.read({ atFiveHourLimit: true, atFiveHourLimitConsent: true }));
  assert.equal(knowingReport.result.kind, "inspected");
  assert.equal(knowing.probes.fiveHourChecks, 0);
});

interface UsageWindow { id: string; label: string; usedRatio: number }
function usageWindow(id: string, usedRatio: number): UsageWindow {
  return { id, label: id, usedRatio };
}
function availableUsage(windows: UsageWindow[]): { kind: "available"; rateLimited: false; windows: UsageWindow[] } {
  return { kind: "available", rateLimited: false, windows };
}

test("the 5-hour limit from a usage snapshot: only claude's one `five_hour` window answers", () => {
  const week = usageWindow("seven_day", 1);
  const below = availableUsage([usageWindow("five_hour", 0.4), week]);
  assert.equal(claudeFiveHourLimitOf(below), "not_at_limit", "the weekly limit is not the 5-hour one");
  const at = availableUsage([usageWindow("five_hour", 1), week]);
  assert.equal(claudeFiveHourLimitOf(at), "at_limit");
  for (const unclear of [
    availableUsage([week]),
    availableUsage([usageWindow("five_hour", 0.4), usageWindow("five_hour", 0.4)]),
    { kind: "unsupported" as const, reason: "quota_unavailable" as const },
    { kind: "reauth_required" as const, reason: "not_authenticated" as const },
  ]) { assert.equal(claudeFiveHourLimitOf(unclear), "unknown"); }
});

test("a keystroke lost on the way: the input box does not show the command, so Enter is not sent", async () => {
  for (const garble of [(typed: string) => typed.replace(/ .*$/u, ""), (typed: string) => typed.slice(0, -1), (typed: string) => `${typed}y`]) {
    const claude = new FakeClaude({ startsAt: "prompt", garble, commands: { "/limit-reset": { shows: "legacy-reset" }, ...confirmFor("weekly") } });
    const report = await finish(driverFor(claude).driver.redeem({ kind: "weekly", idempotencyKey: KEY }));
    assert.deepEqual(report, { result: { kind: "unknown" }, step: "type_command", claudeVersion: "2.1.322" });
    assert.equal(claude.keys(), "/limit-reset weekly", "typed, never submitted");

    const read = new FakeClaude({ startsAt: "prompt", garble, commands: READ_ALL });
    const readReport = await finish(driverFor(read).driver.read({ atFiveHourLimit: false }));
    assert.ok(readReport.result.kind === "inspected");
    assert.deepEqual(readReport.result.resets.map((reset) => reset.state), ["not_checked", "unknown", "unknown", "unknown"]);
    assert.equal(read.keys(), "/limit-reset weekly");
  }
});

test("a dialog drawn a piece at a time and then redrawn: no Yes until it is whole and has held still for the guard", async () => {
  const claude = new FakeClaude({
    startsAt: "prompt",
    commands: { "/limit-reset 5-hour": { shows: "confirm-five_hour", paintedEveryMs: 90, dialog: { afterEnter: "reset-five_hour" } } },
  });
  const { driver } = driverFor(claude);
  const running = driver.redeem({ kind: "five_hour", idempotencyKey: KEY });
  let yesAt = 0;
  let lastPaintBeforeYes = 0;
  const watching = setInterval(() => {
    if (yesAt) { return; }
    if (claude.dialogEnters === 1) { yesAt = Date.now(); }
    else { lastPaintBeforeYes = claude.paintedAt; }
  }, 1);
  const report = await finish(running);
  clearInterval(watching);
  assert.deepEqual(report.result, { kind: "reset" });
  assert.equal(claude.enters("dialog"), 1);
  assert.ok(yesAt - lastPaintBeforeYes >= CLAUDE_DIALOG_KEY_GUARD_MS, `Yes ${yesAt - lastPaintBeforeYes} ms after the last paint`);
});

test("no version list: a prompt under another version's banner is driven, and that version is reported", async () => {
  const claude = new FakeClaude({ startsAt: "prompt", commands: confirmFor("five_hour") });
  const realOpen = claude.open;
  const relabelled: OpenClaudeLimitResetTerminal = (input) => {
    const terminal = realOpen(input);
    if (terminal === null) { return null; }
    return { ...terminal, onData: (listener) => { terminal.onData((chunk) => { listener(chunk.replace("Claude Code v2.1.322", "Claude Code v2.1.400")); }); } };
  };
  const { driver } = driverFor(claude, { openTerminal: relabelled });
  assert.deepEqual(await finish(driver.redeem({ kind: "five_hour", idempotencyKey: KEY })), { result: { kind: "reset" }, claudeVersion: "2.1.400" });
});

/** The dimmed suggestion real 2.1.322 and 2.1.323 draw in an empty input box. */
const withPlaceholder = (text: string): string => text.replace(/^❯\u00A0$/mu, '❯\u00A0Try "how do I log an error?"');

test("the empty input box's placeholder suggestion (real 2.1.322 and 2.1.323) reads as an empty prompt, before the command and after its result", async () => {
  const claude = new FakeClaude({ commands: confirmFor("weekly"), screenText: withPlaceholder });
  const { driver } = driverFor(claude);
  assert.deepEqual(await finish(driver.redeem({ kind: "weekly", idempotencyKey: KEY })), { result: { kind: "reset" }, claudeVersion: "2.1.322" });
  assert.equal(claude.keys(), `${ARROW_DOWN}${ENTER}/limit-reset weekly${ENTER}${ENTER}`);
  assert.equal(claude.dialogEnters, 1);
});

test("Claude Code is started with prompt suggestions off and without an inherited CLAUDECODE marker", async () => {
  const claude = new FakeClaude({ startsAt: "prompt", commands: confirmFor("weekly") });
  let env: NodeJS.ProcessEnv = {};
  const recording: OpenClaudeLimitResetTerminal = (input) => {
    ({ env } = input);
    return claude.open(input);
  };
  const { driver } = driverFor(claude, { openTerminal: recording });
  await finish(driver.redeem({ kind: "weekly", idempotencyKey: KEY, env: { CLAUDECODE: "1" } }));
  assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, "false");
  assert.equal(env.CLAUDECODE, undefined);
});

test("text in the input box that is not the placeholder suggestion stays text, so the prompt is not empty", () => {
  const prompt = "Claude Code v2.1.322\n❯\u00A0Try fixing this\n? for shortcuts";
  assert.equal(promptInput(prompt), "Try fixing this");
  assert.equal(promptInput(prompt.replace("Try fixing this", 'Try "edit <filepath> to..."')), "");
});

test("a prompt with no version banner: nothing is typed, unsupported_version", async () => {
  const claude = new FakeClaude({ startsAt: "prompt", commands: confirmFor("five_hour") });
  const realOpen = claude.open;
  const unbannered: OpenClaudeLimitResetTerminal = (input) => {
    const terminal = realOpen(input);
    if (terminal === null) { return null; }
    return { ...terminal, onData: (listener) => { terminal.onData((chunk) => { listener(chunk.replace("Claude Code v2.1.322", "Claude Code")); }); } };
  };
  const { driver } = driverFor(claude, { openTerminal: unbannered });
  assert.deepEqual(await finish(driver.redeem({ kind: "five_hour", idempotencyKey: KEY })), { result: { kind: "unsupported", reason: "unsupported_version" }, step: "version" });
  const readReport = await finish(driver.read({ atFiveHourLimit: false }));
  assert.deepEqual(readReport.result, { kind: "unsupported", reason: "unsupported_version" });
  assert.equal(claude.keys(), "");
  assert.equal(claude.kills, 2);
});

test("no result after Yes: unknown, and Yes is not sent again", async () => {
  const claude = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows: "confirm-five_hour", dialog: {} } } });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report, { result: { kind: "unknown" }, step: "result", claudeVersion: "2.1.322" });
  assert.equal(claude.dialogEnters, 1);
  assert.equal(claude.writes.filter((write) => write.data === ENTER && (write.during === "dialog" || write.during === "busy")).length, 1);
  assert.equal(claude.kills, 1);
});

test("a result line after Yes that is not this kind's success: unknown", async () => {
  const claude = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows: "confirm-five_hour", dialog: { afterEnter: "kept-five_hour" } } } });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report.result, { kind: "unknown" });
});

test("Windows, macOS and a missing script utility: unsupported, nothing started", async () => {
  const claude = new FakeClaude();
  const there = driverFor(claude, { platform: "win32" });
  const redeemReport = await finish(there.driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(redeemReport.result, { kind: "unsupported", reason: "unsupported_platform" });
  const readReport = await finish(there.driver.read({ atFiveHourLimit: false }));
  assert.deepEqual(readReport.result, { kind: "unsupported", reason: "unsupported_platform" });
  assert.equal(claude.spawns, 0);

  const mac = new FakeClaude({ commands: confirmFor("five_hour") });
  const macReport = await finish(driverFor(mac, { platform: "darwin" }).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(macReport.result, { kind: "unsupported", reason: "unsupported_platform" }, "macOS's script refuses Node's socket stdin");
  assert.equal(mac.spawns, 0);

  const noScript = driverFor(new FakeClaude(), { openTerminal: () => null });
  assert.deepEqual(await finish(noScript.driver.redeem({ kind: "five_hour", idempotencyKey: KEY })), { result: { kind: "unsupported", reason: "unsupported_platform" }, step: "terminal" });
});

test("the same idempotency key again gets the first answer: one session, one Yes", async () => {
  const claude = new FakeClaude({ commands: confirmFor("five_hour") });
  const { driver } = driverFor(claude);
  const first = driver.redeem({ kind: "five_hour", idempotencyKey: KEY });
  const during = driver.redeem({ kind: "five_hour", idempotencyKey: KEY });
  const firstReport = await finish(first);
  assert.deepEqual(firstReport.result, { kind: "reset" });
  const duringReport = await during;
  assert.deepEqual(duringReport.result, { kind: "reset" });
  const laterReport = await finish(driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(laterReport.result, { kind: "reset" });
  assert.equal(claude.spawns, 1);
  assert.equal(claude.dialogEnters, 1);

  // An unknown after the command was submitted is remembered too: nobody knows whether it was spent.
  const stuck = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows: "confirm-five_hour", dialog: {} } } });
  const stuckDriver = driverFor(stuck).driver;
  const stuckReport = await finish(stuckDriver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(stuckReport.result, { kind: "unknown" });
  const retryReport = await finish(stuckDriver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(retryReport.result, { kind: "unknown" });
  assert.equal(stuck.spawns, 1);
});

test("an attempt that never submitted the command is not remembered; another key is another attempt", async () => {
  const claude = new FakeClaude({ startsAt: "silent" });
  const { driver } = driverFor(claude);
  await finish(driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  await finish(driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.equal(claude.spawns, 2);
  await finish(driver.redeem({ kind: "five_hour", idempotencyKey: OTHER_KEY }));
  assert.equal(claude.spawns, 3);
});

test("the same key naming another kind is refused, in flight or after: nothing runs and no answer is reused", async () => {
  const claude = new FakeClaude({ commands: { ...confirmFor("five_hour"), ...confirmFor("weekly") } });
  const { driver } = driverFor(claude);
  const first = driver.redeem({ kind: "five_hour", idempotencyKey: KEY });
  await assert.rejects(driver.redeem({ kind: "weekly", idempotencyKey: KEY }), /another resetId/u, "while the first is running");
  const firstReport = await finish(first);
  assert.deepEqual(firstReport.result, { kind: "reset" });
  await assert.rejects(driver.redeem({ kind: "weekly", idempotencyKey: KEY }), /another resetId/u, "after it");
  assert.equal(claude.spawns, 1);
  assert.equal(claude.dialogEnters, 1);
  assert.ok(!claude.keys().includes("weekly"));
});

test("a request whose turn comes with too little of its budget left is not started", async () => {
  // The first takes over 30 s (a slow start, then a command that never answers); the second arrived at the same moment with 75 s.
  const claude = new FakeClaude({ startsAfterMs: 6000, commands: { "/limit-reset 5-hour": "never", ...confirmFor("weekly") } });
  const { driver } = driverFor(claude);
  const first = driver.redeem({ kind: "five_hour", idempotencyKey: KEY });
  const second = driver.redeem({ kind: "weekly", idempotencyKey: OTHER_KEY });
  const reading = driver.read({ atFiveHourLimit: false });
  const firstReport = await finish(first);
  assert.deepEqual(firstReport.result, { kind: "unknown" });
  assert.deepEqual(await second, { result: { kind: "not_attempted", reason: "deadline" }, step: "queue" });
  assert.equal(claude.spawns, 2, "the redeem needed 45 s and had less; the read needs 20 s and ran");
  const readReport = await reading;
  assert.equal(readReport.result.kind, "inspected");
  assert.ok(!claude.keys().includes(`/limit-reset weekly${ENTER}${ENTER}`), "no Yes for the refused redeem");

  // Nothing was done for that key, so it may try again.
  const againReport = await finish(driver.redeem({ kind: "weekly", idempotencyKey: OTHER_KEY }));
  assert.deepEqual(againReport.result, { kind: "reset" });
});

function queueKey(index: number): string {
  return `${index}f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f`;
}

test("at most two requests wait; a third is refused at once", async () => {
  const claude = new FakeClaude({ commands: READ_ALL });
  const { driver } = driverFor(claude);
  const key = queueKey;
  const running = driver.redeem({ kind: "weekly", idempotencyKey: key(1) });
  const waiting = [driver.read({ atFiveHourLimit: false }), driver.redeem({ kind: "fable", idempotencyKey: key(2) })];
  assert.deepEqual(await driver.redeem({ kind: "full", idempotencyKey: key(3) }), { result: { kind: "not_attempted", reason: "busy" }, step: "queue" });
  assert.deepEqual(await driver.read({ atFiveHourLimit: false }), { result: { kind: "not_attempted", reason: "busy" }, step: "queue" });
  assert.equal(claude.spawns <= 1, true);
  await finish(Promise.all([running, ...waiting]));
  assert.equal(claude.spawns, 3);
  // The slots are free again.
  const freedReport = await finish(driver.redeem({ kind: "full", idempotencyKey: key(3) }));
  assert.deepEqual(freedReport.result, { kind: "reset" });
  assert.equal(claude.spawns, 4);
});

test("a key whose attempt may have spent is kept for the life of the process, however many come after", async () => {
  // Otter's counterexample on #752: an unknown after Yes, then 50 other keys, then the first key again.
  const stuck = new FakeClaude({ startsAt: "prompt", commands: { "/limit-reset 5-hour": { shows: "confirm-five_hour", dialog: {} }, "/limit-reset weekly": { shows: "read-none-weekly" } } });
  const { driver } = driverFor(stuck);
  const first = await finish(driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(first.result, { kind: "unknown" });
  for (let index = 1; index <= 60; index += 1) {
    const other = await finish(driver.redeem({ kind: "weekly", idempotencyKey: `key-${String(index)}` }));
    assert.deepEqual(other.result, { kind: "no_reset" });
  }
  const again = await finish(driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(again.result, { kind: "unknown" });
  assert.equal(stuck.dialogEnters, 1, "one Yes in the process for that key");
  assert.equal(stuck.spawns, 61);
});

test("a call still waiting for the session slot answers at its own deadline and never starts later", async () => {
  // Otter's counterexample on #752: behind an attempt whose Yes gets no answer, an inspection with 100 ms.
  const claude = new FakeClaude({ commands: { "/limit-reset 5-hour": { shows: "confirm-five_hour", dialog: {} }, ...READ_ALL } });
  const { driver } = driverFor(claude);
  const first = driver.redeem({ kind: "five_hour", idempotencyKey: KEY });
  const startedAt = Date.now();
  let answeredAt = 0;
  const waiting = (async () => {
    const report = await driver.read({ atFiveHourLimit: false, timeoutMs: 100 });
    answeredAt = Date.now();
    return report;
  })();
  await vi.advanceTimersByTimeAsync(150);
  assert.ok(answeredAt > 0 && answeredAt - startedAt <= 150, `answered ${String(answeredAt - startedAt)} ms after it was asked`);
  assert.deepEqual(await waiting, { result: { kind: "not_attempted", reason: "deadline" }, step: "queue" });
  await finish(first);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(claude.spawns, 1, "the expired call never opened a session");
});

test("one session at a time: a second request waits for the first", async () => {
  const claude = new FakeClaude({ commands: { ...confirmFor("five_hour"), ...confirmFor("weekly") } });
  const { driver } = driverFor(claude);
  const first = driver.redeem({ kind: "five_hour", idempotencyKey: KEY });
  const second = driver.redeem({ kind: "weekly", idempotencyKey: OTHER_KEY });
  await vi.advanceTimersByTimeAsync(2000);
  assert.equal(claude.spawns, 1, "the second has not started");
  const firstReport = await finish(first);
  assert.deepEqual(firstReport.result, { kind: "reset" });
  const secondReport = await finish(second);
  assert.deepEqual(secondReport.result, { kind: "reset" });
  assert.equal(claude.spawns, 2);
});

const READ_ALL: Record<string, CommandScript> = Object.fromEntries((["weekly", "fable", "full", "five_hour"] as const).map((kind) => [
  `/limit-reset ${KIND_ARGS[kind]}`,
  { shows: `read-confirm-${kind}`, dialog: { afterEscape: `read-kept-${kind}`, afterEnter: `reset-${kind}` } },
]));

/** No Enter reached a `/limit-reset` dialog, and Claude Code accepted none. */
function assertNeverConfirmed(claude: FakeClaude): void {
  assert.equal(claude.enters("dialog"), 0, "no Enter while a dialog was open");
  assert.equal(claude.enters("busy"), 0, "no Enter while a command was running");
  assert.equal(claude.dialogEnters, 0);
}

test("read: every kind is opened with its name and cancelled with Esc; what the dialog shows is the answer", async () => {
  const claude = new FakeClaude({ commands: READ_ALL });
  const report = await finish(driverFor(claude).driver.read({ atFiveHourLimit: false, includeFiveHour: true }));
  assert.deepEqual(report, {
    result: {
      kind: "inspected",
      resets: [
        { id: "five_hour", state: "available", resetsLeft: 2, expiresText: "Nov 19, 5:34pm" },
        { id: "weekly", state: "available", resetsLeft: 1, expiresText: "Nov 16, 5:34pm" },
        { id: "fable", state: "available", resetsLeft: 3, expiresText: "Nov 22, 5:34pm" },
        { id: "full", state: "available", resetsLeft: 1, expiresText: "Nov 30, 5:34pm" },
      ],
      version: "2.1.322",
    },
    claudeVersion: "2.1.322",
  });
  assert.equal(
    claude.keys(),
    `${ARROW_DOWN}${ENTER}/limit-reset weekly${ENTER}${ESCAPE}/limit-reset fable${ENTER}${ESCAPE}/limit-reset full${ENTER}${ESCAPE}/limit-reset 5-hour${ENTER}${ESCAPE}`,
  );
  assertNeverConfirmed(claude);
  assert.equal(claude.spawns, 1, "one session for all four");
});

test("read: the 5-hour kind is not opened unless asked", async () => {
  const claude = new FakeClaude({ commands: READ_ALL });
  const report = await finish(driverFor(claude).driver.read({ atFiveHourLimit: false }));
  assert.ok(report.result.kind === "inspected");
  assert.deepEqual(report.result.resets[0], { id: "five_hour", state: "not_checked" });
  assert.deepEqual(report.result.resets.slice(1).map((reset) => reset.state), ["available", "available", "available"]);
  assert.ok(!claude.keys().includes("5-hour"));
  assertNeverConfirmed(claude);
});

test("read: kinds the account does not hold are none", async () => {
  const claude = new FakeClaude({
    commands: Object.fromEntries((["weekly", "fable", "full", "five_hour"] as const).map((kind) => [`/limit-reset ${KIND_ARGS[kind]}`, { shows: `read-none-${kind}` }])),
  });
  const report = await finish(driverFor(claude).driver.read({ atFiveHourLimit: false, includeFiveHour: true }));
  assert.ok(report.result.kind === "inspected");
  assert.deepEqual(report.result.resets.map((reset) => reset.state), ["none", "none", "none", "none"]);
  assert.equal(report.step, undefined);
  assertNeverConfirmed(claude);
});

test("read: a screen that is not recognised ends the sequence; the kinds after it are unknown and never typed", async () => {
  const claude = new FakeClaude({ commands: { ...READ_ALL, "/limit-reset fable": { shows: "picker", dialog: { afterEnter: "reset-fable" } } } });
  const report = await finish(driverFor(claude).driver.read({ atFiveHourLimit: false, includeFiveHour: true }));
  assert.ok(report.result.kind === "inspected");
  assert.deepEqual(report.result.resets.map((reset) => [reset.id, reset.state]), [
    ["five_hour", "unknown"], ["weekly", "available"], ["fable", "unknown"], ["full", "unknown"],
  ]);
  assert.equal(report.step, "dialog");
  assert.equal(claude.keys(), `${ARROW_DOWN}${ENTER}/limit-reset weekly${ENTER}${ESCAPE}/limit-reset fable${ENTER}${ESCAPE}`);
  assertNeverConfirmed(claude);
});

test("read: a dialog for another kind, or one that will not close, also ends the sequence", async () => {
  const wrongKind = new FakeClaude({ commands: { "/limit-reset weekly": { shows: "read-confirm-fable", dialog: { afterEscape: "read-kept-fable" } } } });
  const wrong = await finish(driverFor(wrongKind).driver.read({ atFiveHourLimit: false }));
  assert.ok(wrong.result.kind === "inspected");
  assert.deepEqual(wrong.result.resets.map((reset) => reset.state), ["not_checked", "unknown", "unknown", "unknown"]);
  assert.equal(wrongKind.keys().split("/limit-reset").length - 1, 1);
  assertNeverConfirmed(wrongKind);

  // Esc leads somewhere other than the "kept" line: the count that was read stands, nothing more is typed.
  const stuck = new FakeClaude({ commands: { "/limit-reset weekly": { shows: "read-confirm-weekly", dialog: { afterEscape: "picker" } } } });
  const stuckReport = await finish(driverFor(stuck).driver.read({ atFiveHourLimit: false }));
  assert.ok(stuckReport.result.kind === "inspected");
  assert.deepEqual(stuckReport.result.resets.map((reset) => reset.state), ["not_checked", "available", "unknown", "unknown"]);
  assert.equal(stuck.keys().split("/limit-reset").length - 1, 1);
});

test("read: the older program's line stops the session at once and says legacy", async () => {
  const claude = new FakeClaude({ commands: { "/limit-reset weekly": { shows: "read-legacy-weekly" }, "/limit-reset fable": { shows: "legacy-reset" } } });
  const report = await finish(driverFor(claude, { cachedFlags: async () => ({ limitResets: false }) }).driver.read({ atFiveHourLimit: false, includeFiveHour: true }));
  assert.deepEqual(report, {
    result: {
      kind: "inspected",
      program: "legacy",
      resets: [
        // Its "isn't available right now" may only mean not at the limit yet: never "none".
        { id: "five_hour", state: "unknown" },
        { id: "weekly", state: "not_offered" },
        { id: "fable", state: "not_offered" },
        { id: "full", state: "not_offered" },
      ],
      version: "2.1.322",
    },
    claudeVersion: "2.1.322",
  });
  assert.equal(claude.keys(), `${ARROW_DOWN}${ENTER}/limit-reset weekly${ENTER}`, "no second /limit-reset in that session");
});

test("read: at the 5-hour limit without consent is refused before anything runs", async () => {
  const claude = new FakeClaude({ commands: READ_ALL });
  const { driver } = driverFor(claude);
  for (const input of [
    { atFiveHourLimit: true },
    { atFiveHourLimit: true, atFiveHourLimitConsent: false, includeFiveHour: true },
    // A caller that does not say is treated as at the limit.
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- What a JavaScript caller can pass.
    { atFiveHourLimit: undefined as unknown as boolean },
  ]) {
    const report = await finish(driver.read(input));
    assert.deepEqual(report, { result: { kind: "unsupported", reason: "consent_required" }, step: "consent" });
  }
  assert.equal(claude.spawns, 0);

  const consented = await finish(driver.read({ atFiveHourLimit: true, atFiveHourLimitConsent: true }));
  assert.equal(consented.result.kind, "inspected");
  assert.equal(claude.spawns, 1);
});

test("read: at the limit with consent, the older program spending its reset is reported, not hidden", async () => {
  const claude = new FakeClaude({ commands: { "/limit-reset weekly": { shows: "legacy-reset", recordedWith: "/limit-reset 5-hour" } } });
  const report = await finish(driverFor(claude).driver.read({ atFiveHourLimit: true, atFiveHourLimitConsent: true }));
  assert.ok(report.result.kind === "inspected");
  assert.equal(report.result.program, "legacy");
  assert.equal(report.result.fiveHourSpent, true);
  assert.deepEqual(report.result.resets[0], { id: "five_hour", state: "unknown" });
  assert.equal(report.step, "result");
  assert.equal(claude.keys().split("/limit-reset").length - 1, 1);
});

test("read: timeout, sign-in and a missing command", async () => {
  const silent = new FakeClaude({ startsAt: "silent" });
  assert.deepEqual(await finish(driverFor(silent).driver.read({ atFiveHourLimit: false })), { result: { kind: "not_attempted", reason: "startup_failed" }, step: "startup" });
  assert.equal(silent.kills, 1);

  const signedOut = new FakeClaude({ startsAt: "sign-in" });
  const signedOutReport = await finish(driverFor(signedOut).driver.read({ atFiveHourLimit: false }));
  assert.deepEqual(signedOutReport.result, { kind: "reauth_required", reason: "not_authenticated" });
  assert.equal(signedOut.keys(), "");

  const noCommand = new FakeClaude({ commands: {} });
  const noCommandReport = await finish(driverFor(noCommand).driver.read({ atFiveHourLimit: false }));
  assert.deepEqual(noCommandReport.result, { kind: "unsupported", reason: "endpoint_unavailable" });

  const hangs = new FakeClaude({ commands: { ...READ_ALL, "/limit-reset fable": "never" } });
  const hung = await finish(driverFor(hangs).driver.read({ atFiveHourLimit: false }));
  assert.ok(hung.result.kind === "inspected");
  assert.deepEqual(hung.result.resets.map((reset) => reset.state), ["not_checked", "available", "unknown", "unknown"]);
  assert.equal(hung.step, "command");
  assertNeverConfirmed(hangs);
  assert.equal(hangs.kills, 1);
});

test("a read and a redeem share the one session slot", async () => {
  const claude = new FakeClaude({ commands: READ_ALL });
  const { driver } = driverFor(claude);
  const reading = driver.read({ atFiveHourLimit: false });
  const redeeming = driver.redeem({ kind: "weekly", idempotencyKey: KEY });
  await vi.advanceTimersByTimeAsync(2000);
  assert.equal(claude.spawns, 1);
  const readReport = await finish(reading);
  assert.equal(readReport.result.kind, "inspected");
  const redeemReport = await finish(redeeming);
  assert.deepEqual(redeemReport.result, { kind: "reset" });
  assert.equal(claude.spawns, 2);
});

for (const kind of ["five_hour", "weekly", "fable", "full"] as const) {
  test(`redeem ${kind}: extra content after the footer refuses with Esc, never Yes`, async () => {
    const claude = new FakeClaude({
      commands: confirmFor(kind),
      screenText: (text, mode) => mode === "dialog" ? `${text}\nThis reset will also spend an additional weekly reset.` : text,
    });
    const report = await finish(driverFor(claude).driver.redeem({ kind, idempotencyKey: KEY }));
    assert.equal(report.result.kind, "unknown");
    assertNeverConfirmed(claude);
    assert.equal(claude.writes.filter((write) => write.data === ESCAPE && write.during === "dialog").length, 1);
  });
}

test("history before a recorded dialog and blank lines after it still allow one confirmation", async () => {
  const claude = new FakeClaude({
    commands: confirmFor("weekly"),
    screenText: (text, mode) => mode === "dialog" ? `Previous command output\n${text}\n \n` : text,
  });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "weekly", idempotencyKey: KEY }));
  assert.equal(report.result.kind, "reset");
  assert.equal(claude.dialogEnters, 1);
});

test("a trust screen with content after its footer is never accepted", async () => {
  const claude = new FakeClaude({ screenText: (text, mode) => mode === "trust" ? `${text}\nAdditional permission requested.` : text });
  const report = await finish(driverFor(claude).driver.redeem({ kind: "five_hour", idempotencyKey: KEY }));
  assert.deepEqual(report.result, { kind: "not_attempted", reason: "startup_failed" });
  assert.equal(claude.enters("trust"), 0);
  assert.equal(claude.keys(), ESCAPE);
  assert.equal(claude.enters("prompt"), 0);
  assert.equal(claude.kills, 1);
});
