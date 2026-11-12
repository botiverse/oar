/** The kinds of reset `/limit-reset` takes, as OAR names them (the `resetId` values). */
export type ClaudeLimitResetKind = "five_hour" | "weekly" | "fable" | "full";
export const CLAUDE_LIMIT_RESET_KINDS: readonly ClaudeLimitResetKind[] = ["five_hour", "weekly", "fable", "full"];

/**
 * What Claude Code's terminal UI shows (recorded from 2.1.322) around `/limit-reset`, read
 * from the screen's text. Every string here is copied from a screen that
 * version drew against a fake backend; nothing is matched loosely, because a
 * screen that is not positively recognised must end the attempt.
 */

/** The argument `/limit-reset` takes for each kind. */
export const CLAUDE_LIMIT_RESET_KIND_ARGS: Record<ClaudeLimitResetKind, string> = {
  five_hour: "5-hour",
  weekly: "weekly",
  fable: "fable",
  full: "full",
};

/** The kind's name as the confirmation dialog writes it ("Use a Fable reset?"). */
const DIALOG_KIND_NAMES: Record<ClaudeLimitResetKind, string> = {
  five_hour: "5-hour",
  weekly: "weekly",
  fable: "Fable",
  full: "full",
};

/** The kind's name in the dialog's count line ("2 five-hour resets left"). */
const COUNT_KIND_NAMES: Record<ClaudeLimitResetKind, string> = {
  five_hour: "five-hour",
  weekly: "weekly",
  fable: "Fable",
  full: "full",
};

/** The line Claude Code prints after a kind's reset was used. */
const SUCCESS_LINES: Record<ClaudeLimitResetKind, RegExp> = {
  five_hour: /^5-hour limit reset · your weekly reset day stays /u,
  weekly: /^Weekly limits reset · your weekly reset day stays /u,
  fable: /^Fable reset used · /u,
  full: /^Limits reset · your weekly reset day stays /u,
};

const DIALOG_FOOTER = "Enter to confirm · Esc to cancel";
const SELECTED = "❯ ";

function kindFromName(names: Record<ClaudeLimitResetKind, string>, name: string): ClaudeLimitResetKind | null {
  for (const kind of CLAUDE_LIMIT_RESET_KINDS) {
    if (names[kind] === name) { return kind; }
  }
  return null;
}

function trimmedLines(screen: string): string[] {
  return screen.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** The slash command typed for a kind, always with its argument. */
export function claudeLimitResetCommand(kind: ClaudeLimitResetKind): string {
  return `/limit-reset ${CLAUDE_LIMIT_RESET_KIND_ARGS[kind]}`;
}

/** Whether any dialog that takes Enter is open. */
export function hasDialogFooter(screen: string): boolean {
  return screen.includes(DIALOG_FOOTER);
}

/**
 * The text in the input box, when there is one and no dialog over it. The box
 * is `❯` and a no-break space, which a submitted command's echo
 * (`❯ /limit-reset …`, a plain space) never has.
 */
export function inputLine(screen: string): string | null {
  if (hasDialogFooter(screen)) { return null; }
  const inputs = screen.split("\n").filter((line) => line.startsWith("❯\u00A0"));
  const [input] = inputs;
  if (inputs.length !== 1 || input === undefined) { return null; }
  return input.slice(2).trimEnd();
}

/**
 * The input box's text when the main prompt is showing, ready for a command,
 * with its status line under it; null on any other screen.
 */
export function promptInput(screen: string): string | null {
  if (!screen.includes("shift+tab to cycle") && !screen.includes("? for shortcuts")) { return null; }
  return inputLine(screen);
}

/**
 * The "do you trust this folder" screen a working directory gets the first
 * time, and which of its two rows is selected ("No, exit" is, when it opens).
 */
export function trustScreen(screen: string): "no_selected" | "yes_selected" | null {
  const lines = trimmedLines(screen);
  const footer = lines.lastIndexOf(DIALOG_FOOTER);
  if (footer < 2 || !lines.some((line) => line.startsWith("Quick safety check: Is this a project you created or one you trust?"))) { return null; }
  const rows = `${lines[footer - 2]}\n${lines[footer - 1]}`;
  if (rows === `${SELECTED}No, exit\nYes, I trust this folder`) { return "no_selected"; }
  if (rows === `No, exit\n${SELECTED}Yes, I trust this folder`) { return "yes_selected"; }
  return null;
}

/** The version in the banner Claude Code draws above its prompt ("Claude Code v2.1.322"); null when there is no banner. */
export function bannerVersion(screen: string): string | null {
  return /(?:^|\s)Claude Code v(\d+\.\d+\.\d+)\s*$/mu.exec(screen)?.[1] ?? null;
}

/** The prompt of a Claude Code with no login: its status line says so. */
export function isSignInScreen(screen: string): boolean {
  return screen.includes("Not logged in · Run /login");
}

export interface ClaudeConfirmDialog {
  kind: ClaudeLimitResetKind;
  /** "2 five-hour resets left": the count the dialog shows, when it shows one. */
  resetsLeft?: number;
  /** "use by Nov 19, 4:58pm", in Claude Code's words. */
  expiresText?: string;
}

/**
 * The confirmation dialog for one kind, only when everything about it is as
 * recorded: the title, the Yes row naming the same kind and selected, the No
 * row below it, and the footer.
 */
export function confirmDialog(screen: string): ClaudeConfirmDialog | null {
  const lines = trimmedLines(screen);
  const footer = lines.lastIndexOf(DIALOG_FOOTER);
  // `footer` is at least 3 here, so every line read below exists.
  if (footer < 3 || lines[footer - 1] !== "No, keep it") { return null; }
  const yes = /^❯ Yes, use my (.+) reset$/u.exec(lines[footer - 2] ?? "");
  if (!yes) { return null; }
  let titleAt = -1;
  for (let index = footer - 3; index >= 0; index -= 1) {
    if (/^Use an? .+\?$/u.test(lines[index] ?? "")) {
      titleAt = index;
      break;
    }
  }
  const title = titleAt < 0 ? null : /^Use a (.+) reset\?$/u.exec(lines[titleAt] ?? "");
  // Group 1 always takes part in a match of either pattern.
  const titleName = title?.[1];
  if (titleName === undefined || titleName !== yes[1]) { return null; }
  const kind = kindFromName(DIALOG_KIND_NAMES, titleName);
  if (!kind) { return null; }
  const dialog: ClaudeConfirmDialog = { kind };
  for (const line of lines.slice(titleAt + 1, footer - 2)) {
    const count = /^(\d{1,3}) (.+) resets? left · use by (.+)$/u.exec(line);
    const expiresText = count?.[3];
    if (!count || count[2] !== COUNT_KIND_NAMES[kind] || expiresText === undefined) { continue; }
    dialog.resetsLeft = Number(count[1]);
    dialog.expiresText = expiresText;
  }
  return dialog;
}

/** What Claude Code printed under a command instead of, or after, a dialog. */
export type ClaudeResultLine =
  /** The kind's reset was used. */
  | { is: "reset"; kind: ClaudeLimitResetKind }
  /** The dialog was cancelled and the reset kept. */
  | { is: "kept" }
  /** The account holds no reset of that kind, or none at all. */
  | { is: "none" }
  /** It holds one that can only be used at a usage limit, and is not at one. */
  | { is: "needs_limit" }
  /** Claude's older once-a-week 5-hour reset was spent, with no confirmation. */
  | { is: "legacy_reset" }
  /** The older reset is not available now. */
  | { is: "legacy_unavailable" }
  /** A line this driver has no record of. */
  | { is: "unrecognised" };

function classifyResultLine(text: string): ClaudeResultLine {
  for (const kind of CLAUDE_LIMIT_RESET_KINDS) {
    if (SUCCESS_LINES[kind].test(text)) { return { is: "reset", kind }; }
  }
  if (/^(5-hour|Weekly|Fable|Full) reset kept · /u.test(text)) { return { is: "kept" }; }
  if (/^No (reset|5-hour reset|weekly reset|Fable reset|full reset) to use · /u.test(text)) { return { is: "none" }; }
  if (text.startsWith("You have a reset saved for when you reach a usage limit · ")) { return { is: "needs_limit" }; }
  if (text.startsWith("5-hour limit reset · next reset available ")) { return { is: "legacy_reset" }; }
  if (text === "A 5-hour limit reset isn't available right now.") { return { is: "legacy_unavailable" }; }
  return { is: "unrecognised" };
}

export type ClaudeCommandScreen =
  /** The confirmation dialog, for whichever kind it names. */
  | { is: "confirm"; dialog: ClaudeConfirmDialog }
  /** Some other dialog that takes Enter (the picker, or one never seen). */
  | { is: "other_dialog" }
  /** The command finished with a line and the prompt is back. */
  | { is: "result"; line: ClaudeResultLine }
  /** This account's Claude Code has no `/limit-reset`. */
  | { is: "no_command" }
  /** Nothing recognisable yet: still drawing, or a screen never seen. */
  | { is: "pending" };

/**
 * What the screen shows for the last `command` submitted. A result counts
 * only once the prompt is back under it, so a line still being drawn or
 * wrapped is never read half way.
 */
export function commandScreen(screen: string, command: string): ClaudeCommandScreen {
  const dialog = confirmDialog(screen);
  if (dialog) { return { is: "confirm", dialog }; }
  if (hasDialogFooter(screen)) { return { is: "other_dialog" }; }
  if (promptInput(screen) !== "") { return { is: "pending" }; }
  if (screen.includes("Unknown command: /limit-reset")) { return { is: "no_command" }; }
  const lines = screen.split("\n");
  const echo = lines.lastIndexOf(`❯ ${command}`);
  if (echo === -1) { return { is: "pending" }; }
  // Group 1 always takes part in a match of either pattern.
  const first = /^ {2}⎿ {2}(\S.*)$/u.exec(lines[echo + 1] ?? "")?.[1];
  if (first === undefined) { return { is: "pending" }; }
  const parts = [first.trimEnd()];
  for (const line of lines.slice(echo + 2)) {
    const continuation = /^ {5}(\S.*)$/u.exec(line)?.[1];
    if (continuation === undefined) { break; }
    parts.push(continuation.trimEnd());
  }
  return { is: "result", line: classifyResultLine(parts.join(" ")) };
}
