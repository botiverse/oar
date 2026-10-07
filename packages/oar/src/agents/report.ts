/**
 * Turning a subagent's report into input for a parent session. Pure, with no
 * Node or adapter imports, so a host that only forwards reports (a server
 * relaying them from another machine) can import it without loading a
 * runtime: `@botiverse/oar/agents/report`. See docs/spec/subagents.md.
 */
import type { InputOrigin } from "../contracts/session.js";
import type { SubagentReport } from "./types.js";

export type { SubagentReport } from "./types.js";

/** The origin to deliver a report with: a notification from that subagent. */
export function reportOrigin(report: SubagentReport): InputOrigin {
  return { kind: "notification", source: `subagent:${report.id}` };
}

export function formatReport(report: SubagentReport): string {
  const outcome = report.outcome.kind === "failed" ? `failed: ${report.outcome.reason}` : report.outcome.kind;
  const who = report.name === undefined || report.name === report.id ? report.id : `${report.id} (${report.name})`;
  return `[subagent ${who} on ${report.runtime}, turn ${String(report.turn)}: ${outcome}; session ${report.sessionId}]\n${report.text}`;
}
