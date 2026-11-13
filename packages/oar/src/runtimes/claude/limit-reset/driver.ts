/* oxlint-disable eslint/max-lines -- One driver: the session, its key rules and both flows read together. */
import { constants } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AccountUsageSnapshot,
  LimitResetInspection,
  LimitResetKindStatus,
  LimitResetResult,
} from "../../../contracts/account-usage.js";
import {
  CLAUDE_LIMIT_RESET_KINDS,
  type ClaudeLimitResetKind,
  claudeLimitResetCommand,
  bannerVersion,
  commandScreen,
  confirmDialog,
  hasDialogFooter,
  inputLine,
  isSignInScreen,
  promptInput,
  trustScreen,
  type ClaudeCommandScreen,
} from "./screens.js";
import { openScriptTerminal, type ClaudeLimitResetTerminal, type OpenClaudeLimitResetTerminal } from "../../../shared/executable/script-terminal.js";
import { TerminalScreen } from "./terminal-screen.js";

/**
 * Claude Code's limit resets, used and read by driving its own terminal UI.
 *
 * Claude Code has no non-interactive way to spend or list limit resets: only
 * the hidden `/limit-reset` command of the interactive UI. So this starts the
 * person's own `claude` in a pseudo-terminal, types the command, and reads
 * the screen. It runs only on the account owner's explicit request, one
 * session at a time in this process, and it fails closed:
 *
 * - No version list: any Claude Code is driven whose banner shows a version,
 *   and every screen must match the recorded text word for word. A version
 *   that changed a screen ends the attempt there (`unknown`, or
 *   `unsupported_version` before the command).
 * - The command always names a kind. A bare `/limit-reset` can spend a reset
 *   with no confirmation.
 * - Enter is sent in three places only (`ClaudeSession`): to accept the
 *   folder-trust screen, to submit a command whose text the input box shows
 *   exactly, and (redeem only) once on the confirmation dialog for the kind
 *   the person chose. A read's session cannot send the third.
 * - From the moment a command is submitted until a screen that is positively
 *   recognised shows it finished, the only key that can be sent is Esc (or
 *   that one Yes). A session is ended by killing it, never by typing.
 * - Any screen that is not positively recognised ends the attempt with Esc.
 *
 * One hazard cannot be closed from here. An account on Claude's older
 * program (one 5-hour reset a week, no kinds) spends that reset as soon as ANY
 * `/limit-reset …` is submitted while Claude Code is at the 5-hour limit,
 * with no dialog. So:
 *
 * - A redeem of any kind but the 5-hour one is refused unless Claude Code's
 *   cached feature flags say the newer program is on. (A fresh flag fetch can
 *   still disagree with that cache.) A 5-hour redeem runs either way: spending
 *   the 5-hour reset is what the person clicked.
 * - A read on an account at its 5-hour limit is refused without the person's
 *   consent to that risk (see `read`), and stops at the first line the older
 *   program prints.
 * - What the server said about the 5-hour limit can be minutes old. So right
 *   before the first command of a read without that consent, or of a redeem
 *   of any kind but the 5-hour one, OAR reads usage again itself and
 *   types only if that read shows the account NOT at its 5-hour limit.
 * - When the older program did spend its reset for something else, the answer
 *   says so (`fiveHourSpent`).
 */

/** The Claude Code version whose `/limit-reset` screens the recognisers were recorded from. */
export const CLAUDE_LIMIT_RESET_RECORDED_VERSION = "2.1.322";
/** The whole budget of one call, from its arrival, unless the caller gives one. */
export const CLAUDE_LIMIT_RESET_TIMEOUT_MS = 75_000;

const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 45;
/** Claude Code ignores keys for about 250 ms after a dialog opens; wait well past that before any key. */
export const CLAUDE_DIALOG_KEY_GUARD_MS = 600;
/**
 * What must be left of the attempt's time before Yes is sent: Claude Code's
 * own claim request can take 25 s, and an answer that comes after the
 * deadline is a spent reset reported as unknown.
 */
export const CLAUDE_CLAIM_WINDOW_MS = 30_000;
/** After the prompt first shows, Claude Code is still fetching the flags that decide what `/limit-reset` does. */
const STARTUP_SETTLE_MS = 3000;
const STARTUP_TIMEOUT_MS = 30_000;
const TYPE_SETTLE_MS = 400;
const TYPE_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 5000;
/** How many times the dialog may still be repainting when its key guard ends before the attempt gives up. */
const STABLE_SCREEN_TRIES = 5;
/** A request that would start with less than this left is not started: a redeem must still reach its dialog with the claim window to spare. */
const REDEEM_MIN_START_MS = CLAUDE_CLAIM_WINDOW_MS + COMMAND_TIMEOUT_MS + STARTUP_SETTLE_MS;
const READ_MIN_START_MS = 20_000;
/**
 * What must be left right before a command is submitted. On the older program
 * the submission itself spends the 5-hour reset, so a redeem must still have
 * the command's time and the claim window ahead of it, or its answer is cut
 * into an unknown; a read must still have the command's time.
 */
export const CLAUDE_REDEEM_MIN_SUBMIT_MS = CLAUDE_CLAIM_WINDOW_MS + COMMAND_TIMEOUT_MS;
const READ_MIN_SUBMIT_MS = COMMAND_TIMEOUT_MS;
/** How long the fresh usage read before the first command may take. */
const FIVE_HOUR_CHECK_TIMEOUT_MS = 15_000;
/** Requests that may wait behind the running one; more are refused at once. */
const MAX_WAITING = 2;

const ENTER = "\r";
const ESCAPE = "\u001B";
const ARROW_DOWN = "\u001B[B";

/** The kinds a read opens, in order; the 5-hour kind last and only when asked. */
const READ_ORDER: readonly ClaudeLimitResetKind[] = ["weekly", "fable", "full", "five_hour"];

/** How far an attempt got; reported on a failure, never with any screen text. */
export type ClaudeLimitResetStep =
  | "consent"
  | "idempotency"
  | "queue"
  | "platform"
  | "installation"
  | "version"
  | "flags"
  | "terminal"
  | "startup"
  | "sign_in"
  | "budget"
  | "usage"
  | "type_command"
  | "command"
  | "dialog"
  | "confirm"
  | "result";

export interface ClaudeLimitResetReport<Result> {
  result: Result;
  /** The installed Claude Code's version, once it was read. */
  claudeVersion?: string;
  /** Where an attempt that did not get its answer stopped. */
  step?: ClaudeLimitResetStep;
}

/** What Claude Code's cached feature flags say; null when the cache does not. */
export interface ClaudeLimitResetFlags { limitResets: boolean | null }

/** Whether usage, read just now, shows the account at its 5-hour limit; `unknown` when it could not be read, which refuses. */
export type ClaudeFiveHourLimit = "at_limit" | "not_at_limit" | "unknown";

/** The 5-hour limit as a usage snapshot shows it: one `five_hour` window. */
export function claudeFiveHourLimitOf(snapshot: AccountUsageSnapshot): ClaudeFiveHourLimit {
  if (snapshot.kind !== "available") { return "unknown"; }
  const windows = snapshot.windows.filter((window) => window.id === "five_hour");
  const [window] = windows;
  if (windows.length !== 1 || window === undefined) { return "unknown"; }
  return window.usedRatio >= 1 ? "at_limit" : "not_at_limit";
}

/** Injectable for tests and the offline harness; production uses the call's `claude` and environment, and the system `script`. */
export interface ClaudeLimitResetDeps {
  readonly platform?: NodeJS.Platform;
  readonly cachedFlags?: (env: NodeJS.ProcessEnv) => Promise<ClaudeLimitResetFlags>;
  /**
   * Reads usage now (not a cached snapshot) and says whether the account is at
   * its 5-hour limit. OAR passes claude's own `accountUsage`; without one
   * every check is `unknown`, so nothing that could spend the older program's
   * reset is typed.
   */
  readonly fiveHourLimit?: (command: string, env: NodeJS.ProcessEnv) => Promise<ClaudeFiveHourLimit>;
  readonly openTerminal?: OpenClaudeLimitResetTerminal;
  /** A new empty directory for the session, and how to remove it. */
  readonly workDir?: () => Promise<{ path: string; remove: () => Promise<void> }>;
  /** The whole budget of one request, from its arrival, when the call gives none. */
  readonly timeoutMs?: number;
  /** The screen at each step, for the offline harness only. Never wired in production: screens name the account's limits. */
  readonly onScreen?: (step: string, screen: string) => void;
}

export interface ClaudeLimitResetRedeemInput {
  /** The `claude` to run. */
  command: string;
  kind: ClaudeLimitResetKind;
  idempotencyKey: string;
  /** The person accepted the older program's risk: no flag check and no usage read before the command. */
  fiveHourLimitConsent?: boolean;
  /** This call's budget; the driver's own when omitted. */
  timeoutMs?: number;
  /** The environment `claude` runs in for this call. */
  env?: NodeJS.ProcessEnv;
  /** This call's usage read, in preference to the driver's. */
  fiveHourLimit?: () => Promise<ClaudeFiveHourLimit>;
}

export interface ClaudeLimitResetsReadInput {
  /** The `claude` to run. */
  command: string;
  /**
   * Whether usage shows the account at its 5-hour limit. There, an account
   * with only the older once-a-week reset spends it the moment any
   * `/limit-reset` command is opened, so a read is refused without consent.
   * `false` (the server's reading, possibly minutes old) is not trusted on
   * its own: without consent OAR reads usage again right before the
   * first command and answers `consent_required` if the account is at the
   * limit now, or `not_attempted` if that read fails.
   */
  atFiveHourLimit: boolean;
  /** The person accepted that risk. */
  atFiveHourLimitConsent?: boolean;
  /** Also open the 5-hour kind; otherwise it is reported `not_checked`. */
  includeFiveHour?: boolean;
  /** This call's budget; the driver's own when omitted. */
  timeoutMs?: number;
  /** The environment `claude` runs in for this call. */
  env?: NodeJS.ProcessEnv;
  /** This call's usage read, in preference to the driver's. */
  fiveHourLimit?: () => Promise<ClaudeFiveHourLimit>;
}

export interface ClaudeLimitResetDriver {
  redeem(input: ClaudeLimitResetRedeemInput): Promise<ClaudeLimitResetReport<LimitResetResult>>;
  read(input: ClaudeLimitResetsReadInput): Promise<ClaudeLimitResetReport<LimitResetInspection>>;
}

/**
 * Linux only. macOS's BSD `script` refuses a socket as its stdin, which is
 * what Node's pipes are there (seen on macOS 27.0, #752), so it exits
 * before starting the program; Windows has neither `script` nor a POSIX
 * shell.
 */
function isDrivablePlatform(platform: NodeJS.Platform): boolean {
  return platform === "linux";
}

/**
 * Claude Code keeps the feature flags it last fetched in its config file. Only
 * the one boolean is read; the file's account fields are not touched.
 */
async function readCachedFlags(env: NodeJS.ProcessEnv): Promise<ClaudeLimitResetFlags> {
  const configDir = env.CLAUDE_CONFIG_DIR;
  const configPath = configDir !== undefined && configDir !== ""
    ? path.join(configDir, ".claude.json")
    : path.join(env.HOME ?? os.homedir(), ".claude.json");
  try {
    const entry = await stat(configPath);
    if (!entry.isFile()) { return { limitResets: null }; }
    // Nonblocking open also handles a regular file replaced by a FIFO after stat.
    const file = await open(configPath, constants.O_RDONLY | constants.O_NONBLOCK);
    let text = "";
    try {
      const opened = await file.stat();
      if (!opened.isFile()) { return { limitResets: null }; }
      text = await file.readFile("utf8");
    } finally {
      await file.close();
    }
    const config: unknown = JSON.parse(text);
    // cachedGrowthBookFeatures.tengu_cedar_ember.enabled; anything else on the way is no answer.
    const features = typeof config === "object" && config !== null && "cachedGrowthBookFeatures" in config ? config.cachedGrowthBookFeatures : undefined;
    const flag = typeof features === "object" && features !== null && "tengu_cedar_ember" in features ? features.tengu_cedar_ember : undefined;
    const enabled = typeof flag === "object" && flag !== null && "enabled" in flag ? flag.enabled : undefined;
    return { limitResets: typeof enabled === "boolean" ? enabled : null };
  } catch {
    return { limitResets: null };
  }
}

/**
 * A new empty directory for the session, so no project settings or hooks
 * apply. Claude Code asks once to trust each new directory (accepted below,
 * it is empty) and keeps one entry for it in its config.
 */
async function makeWorkDir(): Promise<{ path: string; remove: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oar-claude-limit-reset-"));
  return {
    path: directory,
    remove: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * One running Claude Code UI: its screen, its keyboard, and the attempt's
 * deadline. Every key goes through here, and what may be sent depends on two
 * facts it keeps:
 *
 * - `commandOutstanding`: a command was submitted and no recognised screen
 *   has shown it finished. Until then nothing can be typed; only Esc, and
 *   the one Yes.
 * - `yesSent`: the confirmation was accepted. After that the command stays
 *   outstanding for good, so nothing but Esc is ever sent again.
 */
class ClaudeSession {
  private readonly screen = new TerminalScreen(TERMINAL_COLS, TERMINAL_ROWS);
  private readonly wakers = new Set<() => void>();
  private exited = false;
  private changedAt = 0;
  private commandOutstanding = false;
  private yesSent = false;
  /** The version the banner showed, once the prompt was reached. */
  version: string | undefined;

  constructor(
    private readonly terminal: ClaudeLimitResetTerminal,
    private readonly deadlineAt: number,
    /** False for a read: its session has no way to send the confirmation. */
    private readonly mayConfirm: boolean,
    private readonly onScreen: ((step: string, screen: string) => void) | undefined,
  ) {
    terminal.onData((chunk) => {
      const before = this.screen.text();
      this.screen.write(chunk);
      if (this.screen.text() !== before) { this.changedAt = Date.now(); }
      this.wake();
    });
    terminal.onExit(() => {
      this.exited = true;
      this.wake();
    });
  }

  private wake(): void {
    // oxlint-disable-next-line unicorn/no-useless-spread -- A snapshot: each waker that finishes removes itself from the set.
    for (const waker of [...this.wakers]) { waker(); }
  }

  text(): string {
    return this.screen.text();
  }

  note(step: string): void {
    this.onScreen?.(step, this.text());
  }

  remainingMs(): number {
    return this.deadlineAt - Date.now();
  }

  /** Keys at a screen that is not a command's: the folder-trust screen, or text into the empty prompt. Refused while a command is outstanding. */
  type(keys: string): boolean {
    if (this.exited || this.commandOutstanding) { return false; }
    this.terminal.write(keys);
    return true;
  }

  /** The Enter that submits the typed command. From here the command is outstanding. */
  submit(): boolean {
    if (this.exited || this.commandOutstanding) { return false; }
    this.commandOutstanding = true;
    this.terminal.write(ENTER);
    return true;
  }

  /** A recognised screen showed the command finished with the prompt back, so the next one may be typed. Never after a Yes. */
  commandSettled(): void {
    if (!this.yesSent) { this.commandOutstanding = false; }
  }

  /** Esc cancels whatever is open and confirms nothing; always allowed. */
  escape(): void {
    if (!this.exited) { this.terminal.write(ESCAPE); }
  }

  /** The Yes: Enter on the open confirmation dialog, at most once in a session, and never in a read's. */
  confirmOnce(): boolean {
    if (this.exited || !this.mayConfirm || !this.commandOutstanding || this.yesSent) { return false; }
    this.yesSent = true;
    this.terminal.write(ENTER);
    return true;
  }

  /** The first non-null `probe` of the screen; null when `withinMs` or the attempt's deadline passes, or Claude Code exits. */
  // oxlint-disable-next-line typescript/promise-function-async -- Settled by the screen's wakers and a timer, not by awaiting.
  waitFor<T>(probe: (screen: string) => T | null, withinMs: number): Promise<T | null> {
    return new Promise((resolve) => {
      const finish = (value: T | null): void => {
        clearTimeout(timer);
        this.wakers.delete(check);
        resolve(value);
      };
      const check = (): void => {
        const value = probe(this.text());
        if (value !== null) { finish(value); }
        else if (this.exited) { finish(null); }
      };
      const withinDeadlineMs = Math.max(0, Math.min(withinMs, this.remainingMs()));
      const timer = setTimeout(() => { finish(null); }, withinDeadlineMs);
      this.wakers.add(check);
      check();
    });
  }

  /** Waits `ms`; false when the attempt's deadline would pass first or Claude Code has exited. */
  async pause(ms: number): Promise<boolean> {
    if (this.exited || ms > this.remainingMs()) { return false; }
    await new Promise((resolve) => { setTimeout(resolve, ms); });
    return !this.exited;
  }

  /**
   * Waits out the dialog key guard until nothing on the screen has changed
   * for one whole guard, so a key never lands on a dialog that is still being
   * drawn or was just redrawn. False when the deadline comes first or the
   * screen never holds still.
   */
  async pauseUntilStable(): Promise<boolean> {
    for (let tries = 0; tries < STABLE_SCREEN_TRIES; tries += 1) {
      if (!await this.pause(CLAUDE_DIALOG_KEY_GUARD_MS)) { return false; }
      if (Date.now() - this.changedAt >= CLAUDE_DIALOG_KEY_GUARD_MS) { return true; }
    }
    return false;
  }

  /** Ends the session by ending its processes; nothing is typed to leave. */
  async close(): Promise<void> {
    await this.terminal.kill();
  }
}

/**
 * Brings Claude Code to its prompt. A working directory it has not seen gets
 * the folder-trust screen, which opens on "No, exit": Yes is selected first
 * and Enter sent only once the screen shows it selected. The directory is
 * one this driver just made empty. A sign-in screen means no usable login.
 * The prompt counts only under the banner of a tested version (the trust
 * screen comes before any banner).
 */
async function openPrompt(session: ClaudeSession): Promise<"ready" | "sign_in" | "wrong_version" | "failed"> {
  let trustAccepted = false;
  for (;;) {
    // Fixed for this wait; it changes only once the wait is over.
    const lookForTrust = !trustAccepted;
    const seen = await session.waitFor((screen) => {
      if (isSignInScreen(screen)) { return "sign_in"; }
      if (lookForTrust && hasDialogFooter(screen)) { return "trust"; }
      return promptInput(screen) === "" ? "prompt" : null;
    }, STARTUP_TIMEOUT_MS);
    if (seen === null) { return "failed"; }
    if (seen === "sign_in") { return "sign_in"; }
    if (seen === "trust") {
      session.note("trust");
      if (!await session.pauseUntilStable()) { return "failed"; }
      if (trustScreen(session.text()) === "no_selected") {
        session.type(ARROW_DOWN);
        if (await session.waitFor((screen) => (trustScreen(screen) === "yes_selected" ? true : null), CLOSE_TIMEOUT_MS) === null) { return "failed"; }
        if (!await session.pauseUntilStable()) { return "failed"; }
      }
      if (trustScreen(session.text()) !== "yes_selected") { await cancelWithEscape(session); return "failed"; }
      session.type(ENTER);
      trustAccepted = true;
      continue;
    }
    if (!await session.pause(STARTUP_SETTLE_MS)) { return "failed"; }
    const screen = session.text();
    if (isSignInScreen(screen)) { return "sign_in"; }
    if (promptInput(screen) !== "") { continue; }
    const banner = bannerVersion(screen);
    if (banner === null) { return "wrong_version"; }
    session.version = banner;
    return "ready";
  }
}

/**
 * Types `command` at the empty prompt and submits it, only once the input box
 * shows exactly that text: a keystroke lost on the way must not turn it into
 * a bare `/limit-reset`.
 */
async function submitCommand(session: ClaudeSession, command: string): Promise<boolean> {
  if (promptInput(session.text()) !== "") { return false; }
  if (!session.type(command)) { return false; }
  if (!await session.pause(TYPE_SETTLE_MS)) { return false; }
  if (!await session.waitFor((screen) => (inputLine(screen) === command ? true : null), TYPE_TIMEOUT_MS)) { return false; }
  return session.submit();
}

/** Why a command was not submitted: too little time left, or the fresh usage read showed (or could not rule out) the 5-hour limit. */
type SubmitRefusal = "budget" | "at_limit" | "usage_unread";

/**
 * Checked right before a command is submitted. `checkFiveHourLimit`: the
 * submission could spend the older program's 5-hour reset unasked, so usage
 * is read again now and the command goes only if it shows the account not at
 * that limit. The time left is checked before and after that read.
 */
async function maySubmit(session: ClaudeSession, minRemainingMs: number, fiveHourLimit: (() => Promise<ClaudeFiveHourLimit>) | null): Promise<SubmitRefusal | null> {
  if (session.remainingMs() < minRemainingMs) { return "budget"; }
  if (fiveHourLimit) {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const limit = await Promise.race([
      fiveHourLimit().catch((): ClaudeFiveHourLimit => "unknown"),
      new Promise<ClaudeFiveHourLimit>((resolve) => { timer = setTimeout(() => { resolve("unknown"); }, FIVE_HOUR_CHECK_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (limit === "at_limit") { return "at_limit"; }
    if (limit !== "not_at_limit") { return "usage_unread"; }
    if (session.remainingMs() < minRemainingMs) { return "budget"; }
  }
  return null;
}

/**
 * What the submitted command led to; `pending` when nothing recognisable came
 * in time. A result line or "unknown command" under a returned prompt is the
 * recognised end of the command.
 */
async function awaitCommand(session: ClaudeSession, command: string, withinMs: number, settled: (screen: ClaudeCommandScreen) => boolean): Promise<ClaudeCommandScreen> {
  const seen = await session.waitFor((screen) => {
    const shown = commandScreen(screen, command);
    return settled(shown) ? shown : null;
  }, withinMs);
  if (seen?.is === "result" || seen?.is === "no_command") { session.commandSettled(); }
  return seen ?? { is: "pending" };
}

/** Esc, after the dialog key guard; whether no dialog is left afterwards. */
async function cancelWithEscape(session: ClaudeSession): Promise<boolean> {
  if (!await session.pause(CLAUDE_DIALOG_KEY_GUARD_MS)) { return false; }
  session.escape();
  return await session.waitFor((screen) => (hasDialogFooter(screen) ? null : true), CLOSE_TIMEOUT_MS) === true;
}

/** Esc on the confirmation dialog, then whether Claude Code said the reset was kept. */
async function cancelAndSeeKept(session: ClaudeSession, command: string): Promise<boolean> {
  await cancelWithEscape(session);
  const closed = await awaitCommand(session, command, CLOSE_TIMEOUT_MS, (screen) => screen.is === "result");
  return closed.is === "result" && closed.line.is === "kept";
}

/**
 * `remember`: whether the idempotency key keeps this answer. False only when
 * nothing was spent for certain and the answer says nothing lasting about the
 * account, so the same click may be tried again.
 */
interface RedeemOutcome { result: LimitResetResult; step?: ClaudeLimitResetStep; remember: boolean }

const BUSY = { kind: "not_attempted", reason: "busy" } as const;
const DEADLINE = { kind: "not_attempted", reason: "deadline" } as const;
const STARTUP_FAILED = { kind: "not_attempted", reason: "startup_failed" } as const;
const CONSENT_REQUIRED = { kind: "unsupported", reason: "consent_required" } as const;
const NO_COMMAND = { kind: "unsupported", reason: "endpoint_unavailable" } as const;

/** What a refusal before the first command answers; nothing was typed. */
function refusalResult(refused: SubmitRefusal): typeof DEADLINE | typeof CONSENT_REQUIRED | { readonly kind: "not_attempted"; readonly reason: "usage_unread" } {
  return refused === "budget" ? DEADLINE : (refused === "at_limit" ? CONSENT_REQUIRED : { kind: "not_attempted", reason: "usage_unread" } as const);
}

function unknownAt(step: ClaudeLimitResetStep): RedeemOutcome {
  return { result: { kind: "unknown" }, step, remember: true };
}

async function redeemInSession(session: ClaudeSession, kind: ClaudeLimitResetKind, fiveHourLimit: (() => Promise<ClaudeFiveHourLimit>) | null): Promise<RedeemOutcome> {
  const opened = await openPrompt(session);
  session.note("startup");
  if (opened === "sign_in") { return { result: { kind: "reauth_required", reason: "not_authenticated" }, step: "sign_in", remember: false }; }
  if (opened === "wrong_version") { return { result: { kind: "unsupported", reason: "unsupported_version" }, step: "version", remember: false }; }
  if (opened === "failed") { return { result: STARTUP_FAILED, step: "startup", remember: false }; }
  // Nothing has been typed yet: a refusal here spent nothing, and the same click may try again.
  const refused = await maySubmit(session, CLAUDE_REDEEM_MIN_SUBMIT_MS, kind === "five_hour" ? null : fiveHourLimit);
  if (refused) { return { result: refusalResult(refused), step: refused === "budget" ? "budget" : "usage", remember: false }; }
  const command = claudeLimitResetCommand(kind);
  if (!await submitCommand(session, command)) { return { result: { kind: "unknown" }, step: "type_command", remember: false }; }
  const shown = await awaitCommand(session, command, COMMAND_TIMEOUT_MS, (screen) => screen.is !== "pending");
  session.note("command");
  switch (shown.is) {
    case "pending":
      await cancelWithEscape(session);
      return unknownAt("command");
    case "no_command":
      return { result: NO_COMMAND, step: "command", remember: true };
    case "other_dialog":
      await cancelWithEscape(session);
      return unknownAt("dialog");
    case "confirm":
      break;
    case "result":
      switch (shown.line.is) {
        case "none":
          return { result: { kind: "no_reset" }, remember: true };
        case "legacy_unavailable":
          // The older program's "isn't available right now" may only mean the
          // account is not at its 5-hour limit yet, not that it holds none. It
          // has no other kinds at all.
          return { result: kind === "five_hour" ? { kind: "nothing_to_reset" } : { kind: "no_reset" }, remember: true };
        case "needs_limit":
          return { result: { kind: "nothing_to_reset" }, remember: true };
        case "legacy_reset":
          // The older program spent its 5-hour reset with no dialog. That is
          // what a 5-hour click asked for; for any other kind it is not, and
          // the answer says what was spent instead.
          return kind === "five_hour"
            ? { result: { kind: "reset" }, remember: true }
            : { result: { kind: "unknown", fiveHourSpent: true }, step: "result", remember: true };
        case "kept":
        case "reset":
        case "unrecognised":
          return unknownAt("result");
      }
  }
  if (shown.dialog.kind !== kind) {
    await cancelWithEscape(session);
    return unknownAt("dialog");
  }
  if (!await session.pauseUntilStable()) {
    session.escape();
    return unknownAt("confirm");
  }
  if (confirmDialog(session.text())?.kind !== kind) {
    await cancelWithEscape(session);
    return unknownAt("confirm");
  }
  if (session.remainingMs() < CLAUDE_CLAIM_WINDOW_MS) {
    // Too late to wait for the claim's answer: keep the reset and say nothing was done.
    return await cancelAndSeeKept(session, command)
      ? { result: DEADLINE, step: "confirm", remember: false }
      : unknownAt("confirm");
  }
  // The one Yes of the attempt: the dialog names the chosen kind, its Yes row is selected, and it has held still.
  if (!session.confirmOnce()) { return unknownAt("confirm"); }
  const after = await awaitCommand(session, command, CLAUDE_CLAIM_WINDOW_MS, (screen) => screen.is === "result" || screen.is === "other_dialog" || screen.is === "no_command");
  session.note("result");
  if (after.is === "result" && after.line.is === "reset" && after.line.kind === kind) { return { result: { kind: "reset" }, remember: true }; }
  return unknownAt("result");
}

interface ReadOutcome { result: LimitResetInspection; step?: ClaudeLimitResetStep }

/**
 * Opens each kind's command and cancels it with Esc. Its session is made
 * with `mayConfirm` off, so `confirmOnce` sends nothing, and this function
 * does not call it. The Enters it does send are the folder-trust accept and
 * `submitCommand`'s at a prompt that shows exactly the typed command; neither
 * can be sent while a command is outstanding. (On Claude's older program the
 * submission itself is what spends: see the consent in `read`.)
 */
async function readInSession(session: ClaudeSession, kinds: readonly ClaudeLimitResetKind[], fiveHourLimit: (() => Promise<ClaudeFiveHourLimit>) | null): Promise<ReadOutcome> {
  const opened = await openPrompt(session);
  session.note("startup");
  if (opened === "sign_in") { return { result: { kind: "reauth_required", reason: "not_authenticated" }, step: "sign_in" }; }
  if (opened === "wrong_version") { return { result: { kind: "unsupported", reason: "unsupported_version" }, step: "version" }; }
  if (opened === "failed") { return { result: STARTUP_FAILED, step: "startup" }; }
  const found = new Map<ClaudeLimitResetKind, LimitResetKindStatus>();
  let stoppedAt: ClaudeLimitResetStep | undefined = undefined;
  for (const kind of kinds) {
    // After a screen that was not recognised nothing more is typed.
    if (stoppedAt) {
      found.set(kind, { id: kind, state: "unknown" });
      continue;
    }
    // The usage check only before the first command: on the older program
    // that is the only one ever submitted (its line ends the read).
    const refused = await maySubmit(session, READ_MIN_SUBMIT_MS, found.size === 0 ? fiveHourLimit : null);
    if (refused) {
      if (found.size > 0) {
        // Too little time for another command: the kinds left stay not_checked.
        stoppedAt = "budget";
        break;
      }
      return { result: refusalResult(refused), step: refused === "budget" ? "budget" : "usage" };
    }
    const command = claudeLimitResetCommand(kind);
    if (!await submitCommand(session, command)) {
      found.set(kind, { id: kind, state: "unknown" });
      stoppedAt = "type_command";
      continue;
    }
    const shown = await awaitCommand(session, command, COMMAND_TIMEOUT_MS, (screen) => screen.is !== "pending");
    session.note(`command:${kind}`);
    if (shown.is === "no_command") { return { result: NO_COMMAND, step: "command" }; }
    if (shown.is === "result" && (shown.line.is === "legacy_unavailable" || shown.line.is === "legacy_reset")) {
      // The older program answered: it ignores the kind, so every further
      // command would get the same answer, or at the limit spend its reset.
      // `legacy_reset` means it just spent one, which only consent allows.
      // Its "isn't available right now" may only mean the account is not at
      // the 5-hour limit yet, so it is not read as holding none.
      const spent = shown.line.is === "legacy_reset";
      const fiveHour: LimitResetKindStatus = { id: "five_hour", state: "unknown" };
      return {
        result: {
          kind: "inspected",
          program: "legacy",
          ...(spent ? { fiveHourSpent: true as const } : {}),
          resets: CLAUDE_LIMIT_RESET_KINDS.map((each) => (each === "five_hour" ? fiveHour : { id: each, state: "not_offered" })),
          ...(session.version === undefined ? {} : { version: session.version }),
        },
        ...(spent ? { step: "result" as const } : {}),
      };
    }
    if (shown.is === "result" && shown.line.is === "none") {
      found.set(kind, { id: kind, state: "none" });
    } else if (shown.is === "result" && shown.line.is === "needs_limit") {
      // Held, but usable only at a limit; that line's count is not per kind.
      found.set(kind, { id: kind, state: "available" });
    } else if (shown.is === "confirm" && shown.dialog.kind === kind) {
      found.set(kind, {
        id: kind,
        state: "available",
        resetsLeft: shown.dialog.resetsLeft,
        expiresText: shown.dialog.expiresText,
      });
      const kept = await cancelAndSeeKept(session, command);
      session.note(`cancel:${kind}`);
      if (!kept) { stoppedAt = "dialog"; }
    } else {
      found.set(kind, { id: kind, state: "unknown" });
      stoppedAt = shown.is === "result" ? "result" : (shown.is === "pending" ? "command" : "dialog");
      if (shown.is !== "result") { await cancelWithEscape(session); }
    }
  }
  return {
    result: {
      kind: "inspected",
      resets: CLAUDE_LIMIT_RESET_KINDS.map((kind) => found.get(kind) ?? { id: kind, state: "not_checked" }),
      ...(session.version === undefined ? {} : { version: session.version }),
    },
    ...(stoppedAt ? { step: stoppedAt } : {}),
  };
}

const PREPARATION_EXPIRED = Symbol("preparation expired");

/** A late preparation result cannot resume the call; any resource it made is discarded. */
// oxlint-disable-next-line typescript/promise-function-async -- Returns the deadline race directly; late work is handled separately.
function prepareWithinDeadline<T>(run: () => Promise<T>, deadlineAt: number, discard?: (value: T) => Promise<void>): Promise<T | typeof PREPARATION_EXPIRED> {
  if (Date.now() >= deadlineAt) { return Promise.resolve(PREPARATION_EXPIRED); }
  const answer = Promise.withResolvers<T | typeof PREPARATION_EXPIRED>();
  let finished = false;
  const expire = (): void => {
    if (finished) { return; }
    finished = true;
    answer.resolve(PREPARATION_EXPIRED);
  };
  const timer = setTimeout(expire, deadlineAt - Date.now());
  const complete = async (): Promise<void> => {
    try {
      const value = await run();
      // The clock may have passed the deadline before its timer got to run.
      if (Date.now() >= deadlineAt) { expire(); }
      if (finished) { await discard?.(value); }
      else {
        finished = true;
        answer.resolve(value);
      }
    } catch (error) {
      if (Date.now() >= deadlineAt) { expire(); }
      if (!finished) {
        finished = true;
        answer.reject(error);
      }
    } finally {
      clearTimeout(timer);
    }
  };
  void complete();
  return answer.promise;
}

type Refusal = { kind: "unsupported"; reason: "unsupported_platform" | "consent_required" } | typeof DEADLINE;
type Preflight =
  | { ok: true; command: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform }
  | { ok: false; refusal: Refusal; step: ClaudeLimitResetStep };

type RedeemReport = ClaudeLimitResetReport<LimitResetResult>;
interface RedeemAttempt { kind: ClaudeLimitResetKind; inFlight: boolean; report: Promise<RedeemReport> }

export function createClaudeLimitResetDriver(deps: ClaudeLimitResetDeps = {}): ClaudeLimitResetDriver {
  const defaultTimeoutMs = deps.timeoutMs ?? CLAUDE_LIMIT_RESET_TIMEOUT_MS;
  // One Claude Code session at a time in this process. A request that
  // arrives while another runs waits its turn, but its clock started when it
  // arrived: if too little of its budget is left when its turn comes it is
  // refused without starting anything (`not_attempted: deadline`), and so is
  // one that finds MAX_WAITING already waiting (`not_attempted: busy`).
  // Nothing was spent either way; try again.
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  /**
   * Runs `run` when the session slot is free. A call that is still waiting at
   * `deadlineAt` answers `expired()` then and never starts; it frees its
   * waiting place at once.
   */
  const exclusive = <T>(run: () => Promise<T>, deadlineAt: number, expired: () => T): Promise<T> | null => {
    if (queued > MAX_WAITING) { return null; }
    queued += 1;
    // An object, so the timer's and the turn's changes are seen by each other's checks.
    const entry: { state: "waiting" | "running" | "expired" } = { state: "waiting" };
    const answer = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      if (entry.state !== "waiting") { return; }
      entry.state = "expired";
      queued -= 1;
      answer.resolve(expired());
    }, Math.max(0, deadlineAt - Date.now()));
    const turn = async (): Promise<void> => {
      if (entry.state === "expired") { return; }
      entry.state = "running";
      clearTimeout(timer);
      try {
        answer.resolve(await run());
      } catch (error) {
        answer.reject(error);
      } finally {
        queued -= 1;
      }
    };
    // oxlint-disable-next-line promise/prefer-await-to-then -- A queue: the turn is chained now, so the tail is set before this returns.
    tail = tail.then(turn, turn);
    return answer.promise;
  };
  // The wire to Claude Code has no idempotency key, so this remembers each
  // key's attempt, in memory: a retry with the same key gets the first
  // attempt's answer instead of a second Yes. It does not survive the
  // process; after a restart, a retry of an attempt whose answer was lost is
  // a new attempt. Nothing is dropped: an attempt that may have spent a
  // reset must never become executable again within the process. Only
  // attempts that typed a command are kept, each one person's request.
  const attempts = new Map<string, RedeemAttempt>();

  const preflight = async (input: { command: string; env?: NodeJS.ProcessEnv }, needsNewerProgram: boolean, deadlineAt: number): Promise<Preflight> => {
    const platform = deps.platform ?? process.platform;
    if (!isDrivablePlatform(platform)) { return { ok: false, refusal: { kind: "unsupported", reason: "unsupported_platform" }, step: "platform" }; }
    const env = { ...(input.env ?? process.env) };
    // A host started from inside Claude Code must not hand that marker down.
    delete env.CLAUDECODE;
    // Without consent, a kind but the 5-hour one goes only where Claude Code's
    // last fetched flags say the newer program is on (a fresh fetch can still
    // disagree, which the usage read before the command covers).
    if (needsNewerProgram) {
      const loadFlags = deps.cachedFlags ?? readCachedFlags;
      const flags = await prepareWithinDeadline(loadFlags.bind(null, env), deadlineAt);
      if (flags === PREPARATION_EXPIRED) { return { ok: false, refusal: DEADLINE, step: "flags" }; }
      if (flags.limitResets !== true) {
        return { ok: false, refusal: { kind: "unsupported", reason: "consent_required" }, step: "flags" };
      }
    }
    return { ok: true, command: input.command, env, platform };
  };

  /**
   * Runs `drive` against a new Claude Code session in a new empty directory.
   * The session's processes are ended, and that is waited for, before the
   * directory is removed and before the next request's turn.
   */
  const withSession = async <T>(ready: Extract<Preflight, { ok: true }>, deadlineAt: number, mayConfirm: boolean, drive: (session: ClaudeSession) => Promise<T>): Promise<T | null | typeof PREPARATION_EXPIRED> => {
    const workDir = await prepareWithinDeadline(deps.workDir ?? makeWorkDir, deadlineAt, async (late) => { await late.remove(); });
    if (workDir === PREPARATION_EXPIRED) { return PREPARATION_EXPIRED; }
    if (Date.now() >= deadlineAt) {
      // oxlint-disable-next-line promise/prefer-await-to-then -- Cleanup must not delay an already expired call.
      void workDir.remove().catch(() => {});
      return PREPARATION_EXPIRED;
    }
    try {
      const terminal = (deps.openTerminal ?? openScriptTerminal)({
        command: ready.command,
        cwd: workDir.path,
        env: ready.env,
        cols: TERMINAL_COLS,
        rows: TERMINAL_ROWS,
        platform: ready.platform,
      });
      if (!terminal) { return null; }
      const session = new ClaudeSession(terminal, deadlineAt, mayConfirm, deps.onScreen);
      try {
        return await drive(session);
      } finally {
        await session.close().catch(() => {});
      }
    } finally {
      await workDir.remove().catch(() => {});
    }
  };

  const fiveHourCheck = (input: { fiveHourLimit?: () => Promise<ClaudeFiveHourLimit> }, ready: Extract<Preflight, { ok: true }>): (() => Promise<ClaudeFiveHourLimit>) =>
    // oxlint-disable-next-line typescript/promise-function-async -- Hands on the caller's own usage read as it is.
    (): Promise<ClaudeFiveHourLimit> =>
      input.fiveHourLimit ? input.fiveHourLimit() : (deps.fiveHourLimit ? deps.fiveHourLimit(ready.command, ready.env) : Promise.resolve("unknown"));

  const redeemOnce = async (input: ClaudeLimitResetRedeemInput, deadlineAt: number, timeoutMs: number): Promise<RedeemReport & { remember: boolean }> => {
    if (deadlineAt - Date.now() < Math.min(REDEEM_MIN_START_MS, timeoutMs)) { return { result: DEADLINE, step: "queue", remember: false }; }
    const consent = input.fiveHourLimitConsent === true;
    const ready = await preflight(input, input.kind !== "five_hour" && !consent, deadlineAt);
    if (!ready.ok) { return { result: ready.refusal, step: ready.step, remember: false }; }
    // oxlint-disable-next-line eslint/init-declarations -- Set in the session's finally; an initial undefined would read as always undefined to TypeScript.
    let version: string | undefined;
    const outcome = await withSession(ready, deadlineAt, true, async (session) => {
      try {
        return await redeemInSession(session, input.kind, consent ? null : fiveHourCheck(input, ready));
      } finally {
        version = session.version;
      }
    });
    if (outcome === PREPARATION_EXPIRED) { return { result: DEADLINE, step: "terminal", remember: false }; }
    if (!outcome) { return { result: { kind: "unsupported", reason: "unsupported_platform" }, step: "terminal", remember: false }; }
    return { result: outcome.result, ...(outcome.step ? { step: outcome.step } : {}), ...(version === undefined || version === "" ? {} : { claudeVersion: version }), remember: outcome.remember };
  };

  return {
    // oxlint-disable-next-line typescript/promise-function-async -- A retry with the same key gets the first attempt's very promise.
    redeem: (input) => {
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      const deadlineAt = Date.now() + timeoutMs;
      const earlier = attempts.get(input.idempotencyKey);
      if (earlier) {
        // One key is one request for one kind. The same key naming another
        // kind is not a retry, and the first attempt's answer is not its answer.
        if (earlier.kind !== input.kind) { return Promise.reject(new Error("Claude limit reset: this idempotencyKey was used for another resetId")); }
        return earlier.report;
      }
      const attempt: RedeemAttempt = { kind: input.kind, inFlight: true, report: Promise.resolve({ result: BUSY }) };
      const report = exclusive(async (): Promise<RedeemReport> => {
        // A throw after the session opened leaves it unknown what was sent.
        const { remember, ...outcome } = await redeemOnce(input, deadlineAt, timeoutMs).catch(() => ({ result: { kind: "unknown" } as const, remember: true }));
        attempt.inFlight = false;
        if (!remember && attempts.get(input.idempotencyKey) === attempt) { attempts.delete(input.idempotencyKey); }
        return outcome;
      }, deadlineAt, (): RedeemReport => {
        // Never started: nothing was sent, so the same key may try again.
        attempt.inFlight = false;
        if (attempts.get(input.idempotencyKey) === attempt) { attempts.delete(input.idempotencyKey); }
        return { result: DEADLINE, step: "queue" };
      });
      if (!report) { return Promise.resolve({ result: BUSY, step: "queue" }); }
      attempt.report = report;
      attempts.set(input.idempotencyKey, attempt);
      return report;
    },
    // oxlint-disable-next-line typescript/promise-function-async -- Answers with the queued run's own promise, as redeem does.
    read: (input) => {
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      const deadlineAt = Date.now() + timeoutMs;
      // Refused before anything runs; see ClaudeLimitResetsReadInput. A caller that does not say counts as at the limit.
      // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- JavaScript callers can omit it; only an explicit false goes on.
      if (input.atFiveHourLimit !== false && input.atFiveHourLimitConsent !== true) {
        return Promise.resolve({ result: CONSENT_REQUIRED, step: "consent" });
      }
      const kinds = READ_ORDER.filter((kind) => kind !== "five_hour" || input.includeFiveHour === true);
      const report = exclusive(async (): Promise<ClaudeLimitResetReport<LimitResetInspection>> => {
        try {
          if (deadlineAt - Date.now() < Math.min(READ_MIN_START_MS, timeoutMs)) { return { result: DEADLINE, step: "queue" }; }
          const ready = await preflight(input, false, deadlineAt);
          if (!ready.ok) { return { result: ready.refusal, step: ready.step }; }
          // oxlint-disable-next-line eslint/init-declarations -- As in redeemOnce.
          let version: string | undefined;
          const outcome = await withSession(ready, deadlineAt, false, async (session) => {
            try {
              return await readInSession(session, kinds, input.atFiveHourLimitConsent === true ? null : fiveHourCheck(input, ready));
            } finally {
              version = session.version;
            }
          });
          if (outcome === PREPARATION_EXPIRED) { return { result: DEADLINE, step: "terminal" }; }
          if (!outcome) { return { result: { kind: "unsupported", reason: "unsupported_platform" }, step: "terminal" }; }
          return { result: outcome.result, ...(outcome.step ? { step: outcome.step } : {}), ...(version === undefined || version === "" ? {} : { claudeVersion: version }) };
        } catch {
          return { result: { kind: "unknown" } };
        }
      }, deadlineAt, (): ClaudeLimitResetReport<LimitResetInspection> => ({ result: DEADLINE, step: "queue" }));
      return report ?? Promise.resolve({ result: BUSY, step: "queue" });
    },
  };
}
