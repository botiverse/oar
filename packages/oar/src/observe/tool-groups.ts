import type { ViewPart } from "./session-view.js";
import { classifyTool, type ToolActionKind } from "./tool-activity.js";

/**
 * A turn's work between its words, for hosts that show it as one line ("Ran 3 commands, read
 * a file") opening to the calls. Pure, over a section's parts (same pattern as tasksOf): tool
 * calls and the reasoning between them, back to back, make one group; text, notices and app
 * requests stay where they are and end a group. The counts are data, so a host can word or
 * translate them; `toolGroupSummary` is the English line.
 */

export type ToolPart = Extract<ViewPart, { kind: "tool" }>;
export type ReasoningPart = Extract<ViewPart, { kind: "reasoning" }>;

export interface ToolGroup {
  readonly kind: "tools";
  /** Where the group starts in the section's parts. */
  readonly index: number;
  /** Its tool calls and reasoning, in order. */
  readonly parts: readonly (ToolPart | ReasoningPart)[];
  /** Tool calls by `classifyTool` kind, each kind once, in the order it first came. */
  readonly counts: readonly { readonly kind: ToolActionKind; readonly count: number }[];
  /** Calls whose result is `failed`. */
  readonly failed: number;
  /** The call still running, if one is: what a live line names. */
  readonly running?: ToolPart;
}

export type ToolGroupSegment =
  | { readonly kind: "part"; readonly index: number; readonly part: ViewPart }
  | ToolGroup;

function group(runtimeId: string, index: number, parts: readonly (ToolPart | ReasoningPart)[]): ToolGroup {
  const counts = new Map<ToolActionKind, number>();
  const tools = parts.filter((part): part is ToolPart => part.kind === "tool");
  for (const tool of tools) {
    const { kind } = classifyTool(runtimeId, tool.tool, tool.input);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const failed = tools.filter((tool) => tool.result === "failed").length;
  const running = tools.findLast((tool) => tool.result === "running");
  return {
    kind: "tools",
    index,
    parts,
    counts: [...counts].map(([kind, count]) => ({ kind, count })),
    failed,
    ...(running === undefined ? {} : { running }),
  };
}

/** A section's parts as they read: words and requests as they are, the work between them grouped. */
export function groupToolActivity(runtimeId: string, parts: readonly ViewPart[]): ToolGroupSegment[] {
  const segments: ToolGroupSegment[] = [];
  let pending: { index: number; parts: (ToolPart | ReasoningPart)[] } | null = null;
  const flush = (): void => {
    if (pending !== null) {
      segments.push(group(runtimeId, pending.index, pending.parts));
      pending = null;
    }
  };
  for (const [index, part] of parts.entries()) {
    if (part.kind === "tool" || part.kind === "reasoning") {
      pending ??= { index, parts: [] };
      pending.parts.push(part);
    } else {
      flush();
      segments.push({ kind: "part", index, part });
    }
  }
  flush();
  return segments;
}

const DONE: Record<ToolActionKind, (count: number) => string> = {
  run_command: (n) => (n === 1 ? "ran a command" : `ran ${n} commands`),
  read_file: (n) => (n === 1 ? "read a file" : `read ${n} files`),
  edit_file: (n) => (n === 1 ? "edited a file" : `edited ${n} files`),
  search: (n) => (n === 1 ? "searched" : `searched ${n} times`),
  web: (n) => (n === 1 ? "searched the web" : `searched the web ${n} times`),
  mcp: (n) => (n === 1 ? "used a tool" : `used ${n} tools`),
  other: (n) => (n === 1 ? "used a tool" : `used ${n} tools`),
};

/**
 * The English line for a group's counts: "Ran 3 commands, read a file". MCP and unclassified
 * tools read alike ("used 2 tools"). Empty for a group with no calls (only reasoning).
 */
export function toolGroupSummary(counts: ToolGroup["counts"]): string {
  const tools = counts
    .filter(({ kind }) => kind === "mcp" || kind === "other")
    .reduce((sum, { count }) => sum + count, 0);
  const phrases: string[] = [];
  let toolsSaid = false;
  for (const { kind, count } of counts) {
    if (kind === "mcp" || kind === "other") {
      if (!toolsSaid) {
        phrases.push(DONE.other(tools));
        toolsSaid = true;
      }
    } else {
      phrases.push(DONE[kind](count));
    }
  }
  const text = phrases.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
