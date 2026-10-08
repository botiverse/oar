/**
 * Turning a subagent's report into input for a parent session. Pure, with no
 * Node or adapter imports, so a host that only forwards reports (a server
 * relaying them from another machine) can import it without loading a
 * runtime: `@botiverse/oar/agents/report`. See docs/spec/subagents.md.
 */
import type { InputOrigin, TurnOutcome } from "../contracts/session.js";
import type { SubagentReport } from "./types.js";

export type { SubagentReport } from "./types.js";

/** Only the outcome information encoded in a report header; failure classifications are not written there. */
export type ReportOutcome = { readonly kind: "completed" | "aborted" } | { readonly kind: "failed"; readonly reason: string };

/** The fields `formatReport` actually writes, without inventing a timestamp, log path or failure classification. */
export interface ParsedReport {
  readonly id: string;
  readonly name?: string;
  readonly runtime: string;
  readonly turn: number;
  readonly outcome: ReportOutcome;
  readonly sessionId: string;
  readonly body: string;
}

function formatOutcome(outcome: TurnOutcome): string {
  switch (outcome.kind) {
    case "completed": return "completed";
    case "aborted": return "aborted";
    case "failed": return `failed: ${outcome.reason}`;
    default: { const unexpected: never = outcome; throw new Error(`Unknown report outcome: ${String(unexpected)}`); }
  }
}

/** The origin to deliver a report with: a notification from that subagent. */
export function reportOrigin(report: SubagentReport): InputOrigin {
  return { kind: "notification", source: `subagent:${report.id}` };
}

export function formatReport(report: SubagentReport): string {
  const outcome = formatOutcome(report.outcome);
  const who = report.name === undefined || report.name === report.id ? report.id : `${report.id} (${report.name})`;
  return `[subagent ${who} on ${report.runtime}, turn ${String(report.turn)}: ${outcome}; session ${report.sessionId}]\n${report.text}`;
}

const OUTCOMES = {
  completed: (text: string): ReportOutcome | null => text === "completed" ? { kind: "completed" } : null,
  aborted: (text: string): ReportOutcome | null => text === "aborted" ? { kind: "aborted" } : null,
  failed: (text: string): ReportOutcome | null => text.startsWith("failed: ") ? { kind: "failed", reason: text.slice("failed: ".length) } : null,
} satisfies Record<TurnOutcome["kind"], (text: string) => ReportOutcome | null>;

/**
 * Read `formatReport`'s existing text format, or null for a non-report. Body and failed
 * reason are preserved verbatim. Session ids contain no whitespace or closing bracket.
 * The legacy header has no escaping: `x (y)` is id `x`, name `y`, even if the original id
 * itself contained ` (y)`. An omitted name (including name === id) cannot be recovered.
 */
export function parseReport(text: string): ParsedReport | null {
  // The first complete header ends before the body, even if the body quotes another report.
  const envelope = /^\[subagent ([\s\S]*?; session [^\s\]]+)\]\n([\s\S]*)$/u.exec(text);
  const header = envelope?.[1];
  const body = envelope?.[2];
  if (header === undefined || body === undefined) {
    return null;
  }
  // Split from the right so semicolons, parentheses and '; session' in a reason survive.
  const sessionAt = header.lastIndexOf("; session ");
  const sessionId = header.slice(sessionAt + "; session ".length);
  const fields = /^([\s\S]+?) on ([^\s,]+), turn ([1-9][0-9]*): ([\s\S]*)$/u.exec(header.slice(0, sessionAt));
  const [, who, runtime, turnText, outcomeText] = fields ?? [];
  if (who === undefined || runtime === undefined || turnText === undefined || outcomeText === undefined) {
    return null;
  }
  const turn = Number(turnText);
  const outcome = Object.values(OUTCOMES).map((parse) => parse(outcomeText)).find((value) => value !== null);
  if (!Number.isSafeInteger(turn) || outcome === undefined) {
    return null;
  }
  const named = /^([\s\S]+?) \(([\s\S]*)\)$/u.exec(who);
  const id = named?.[1] ?? who;
  const name = named?.[2];
  return { id, ...(name === undefined ? {} : { name }), runtime, turn, outcome, sessionId, body };
}
