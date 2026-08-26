import { asRecord, parseJson } from "../shared/json.js";

/**
 * Cross-runtime tool classification — the friendly-Activity utility. Each
 * runtime names the same action differently (claude "Bash", codex
 * "commandExecution", pi "bash"); only OAR knows the mapping, so it lives
 * here. Pure: raw tool_call events stay the source of truth; a friendly view
 * derives labels via this (same pattern as reduceStatus / aggregateDeltas).
 *
 * The tool set is OPEN (custom + MCP tools have arbitrary names), so unknown
 * tools fall back to "other" rather than being force-fit.
 */

export type ToolActionKind =
  | "run_command"
  | "read_file"
  | "edit_file"
  | "search"
  | "web"
  | "mcp"
  | "other";

export interface ToolAction {
  readonly kind: ToolActionKind;
  /** A short target extracted from the tool input: the command text, a file path, a query. */
  readonly detail?: string;
}

// Per-runtime tool name → kind. Names are what the tool_call_started event
// carries (codex uses its item type; claude/pi use the tool name).
const BY_RUNTIME: Record<string, Record<string, ToolActionKind>> = {
  claude: {
    Bash: "run_command",
    Read: "read_file",
    Edit: "edit_file",
    Write: "edit_file",
    NotebookEdit: "edit_file",
    Grep: "search",
    Glob: "search",
    WebFetch: "web",
    WebSearch: "web",
  },
  codex: {
    commandExecution: "run_command",
    fileChange: "edit_file",
    webSearch: "web",
    mcpToolCall: "mcp",
  },
  pi: {
    bash: "run_command",
    read: "read_file",
    ls: "read_file",
    edit: "edit_file",
    write: "edit_file",
    grep: "search",
    find: "search",
  },
};

function kindOf(runtimeId: string, tool: string): ToolActionKind {
  const runtime = runtimeId.replace(/-aimock$/u, "");
  const direct = BY_RUNTIME[runtime]?.[tool];
  if (direct !== undefined) {
    return direct;
  }
  // MCP tools are conventionally prefixed on claude (mcp__server__tool).
  if (tool.startsWith("mcp__")) {
    return "mcp";
  }
  return "other";
}

const FIRST_STRING_KEYS = ["command", "cmd", "path", "file_path", "filePath", "file", "pattern", "query", "url"];

function detailOf(inputJson: string | undefined): string | undefined {
  if (inputJson === undefined) {
    return undefined;
  }
  const input = asRecord(parseJson(inputJson));
  if (input === null) {
    return undefined;
  }
  for (const key of FIRST_STRING_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    // codex nests the shell command as ["bash","-lc", "<cmd>"] sometimes.
    if (Array.isArray(value)) {
      const last: unknown = value.at(-1);
      if (typeof last === "string" && last.length > 0) {
        return last;
      }
    }
  }
  return undefined;
}

/** Classify one tool call into a cross-runtime semantic action plus an extracted detail. */
export function classifyTool(runtimeId: string, tool: string, inputJson?: string): ToolAction {
  const kind = kindOf(runtimeId, tool);
  const detail = detailOf(inputJson) ?? (kind === "other" ? tool : undefined);
  return detail === undefined ? { kind } : { kind, detail };
}

const LABELS: Record<ToolActionKind, { running: string; done: string; failed: string }> = {
  run_command: { running: "Running command", done: "Ran command", failed: "Command failed" },
  read_file: { running: "Reading file", done: "Read file", failed: "Read failed" },
  edit_file: { running: "Editing file", done: "Edited file", failed: "Edit failed" },
  search: { running: "Searching", done: "Searched", failed: "Search failed" },
  web: { running: "Searching the web", done: "Searched the web", failed: "Web request failed" },
  mcp: { running: "Using a tool", done: "Used a tool", failed: "Tool failed" },
  other: { running: "Working", done: "Done", failed: "Failed" },
};

/** The human label for an action in a given lifecycle state — tense centralized here so views stay consistent. */
export function toolActionLabel(kind: ToolActionKind, state: "running" | "done" | "failed"): string {
  return LABELS[kind][state];
}
