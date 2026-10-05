import { asNumber, asRecord, parseJson } from "../shared/json.js";

/**
 * Cross-runtime tool classification: the friendly-Activity utility. Each
 * runtime names the same action differently (claude "Bash", codex
 * "commandExecution", pi "bash"); only OAR knows the mapping, so it lives
 * here. Pure: raw tool_call events stay the source of truth; a friendly rendering
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
  | "wait"
  | "other";

export interface ToolAction {
  readonly kind: ToolActionKind;
  /** A short target extracted from the tool input: the command text, a file path, a query. */
  readonly detail?: string;
  /**
   * `run_command`: the command line as the runtime reported it. Set only for runtimes whose
   * shell input shape is recorded (claude `Bash`, codex `commandExecution`, pi `bash`, cursor `shell`,
   * grok `run_terminal_command`).
   */
  readonly command?: string;
  /** The agent's own one-line account of the call, where the runtime sends one (claude `Bash`, grok `run_terminal_command`). */
  readonly description?: string;
  /**
   * `wait`: how long the agent asked to wait, in ms, as the runtime reported it (codex
   * `sleep`'s `durationMs`). How long it waited, as OAR saw it, is the tool part's
   * `endedAt - startedAt` (when OAR observed the call start and end): a steer can end a
   * wait early.
   */
  readonly durationMs?: number;
}

// Per-runtime tool name → kind. Names are what the tool_call_started event
// carries (codex uses its item type; claude/pi use the tool name; the ACP
// runtimes the opening `tool_call`'s `title`, shared/acp/projection.ts).
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
    sleep: "wait",
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
  // The opening `tool_call` titles recorded in tests/replay/fixtures/<id>-acp-v1.vendor.json
  // (grok 1.0.5, kimi 0.38.0); ACP's `kind` is no help (grok sends none, kimi a category).
  grok: { run_terminal_command: "run_command" },
  kimi: { Bash: "run_command" },
  // The `toolCall.type` of `@cursor/sdk` 1.0.35's tool updates.
  cursor: {
    shell: "run_command",
    read: "read_file",
    ls: "read_file",
    edit: "edit_file",
    write: "edit_file",
    delete: "edit_file",
    grep: "search",
    glob: "search",
    semSearch: "search",
    webSearch: "web",
    webFetch: "web",
    mcp: "mcp",
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

type InputFields = Pick<ToolAction, "command" | "description" | "durationMs">;

/** The recorded keys' string values: `command` and, where the shape has one, `description`. */
function stringFields(inputJson: string, withDescription: boolean): InputFields {
  const input = asRecord(parseJson(inputJson));
  const pick = (key: string): string | undefined => {
    const value = input?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const command = pick("command");
  const description = withDescription ? pick("description") : undefined;
  return {
    ...(command === undefined ? {} : { command }),
    ...(description === undefined ? {} : { description }),
  };
}

/** A wait's asked duration: the input's `durationMs`, when a finite positive number. */
function waitFields(inputJson: string): InputFields {
  const durationMs = asNumber(asRecord(parseJson(inputJson))?.durationMs);
  return durationMs !== null && durationMs > 0 ? { durationMs } : {};
}

/**
 * Where each runtime's tools keep the fields a host shows, from recorded inputs
 * (tests/replay/fixtures/*-tool-round.raw.jsonl, and the input keys of
 * *-acp-v1.vendor.json): a shell tool's command (and description), a wait's
 * duration. A runtime with no recorded shape gets none. codex's
 * `commandExecution` input is the bare command line, not JSON
 * (codex/item-detail.ts). grok's opening `tool_call` carries `rawInput`
 * `{command, description}`; kimi's carries none (its arguments arrive on a
 * later update), so a kimi `Bash` start has no input to read.
 */
const FIELDS: Record<string, Record<string, (input: string) => InputFields>> = {
  claude: { Bash: (input) => stringFields(input, true) },
  codex: {
    commandExecution: (input) =>
      input.length === 0 || asRecord(parseJson(input)) !== null ? {} : { command: input },
    sleep: waitFields,
  },
  pi: { bash: (input) => stringFields(input, false) },
  cursor: { shell: (input) => stringFields(input, false) },
  grok: { run_terminal_command: (input) => stringFields(input, true) },
};

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
  const runtime = runtimeId.replace(/-aimock$/u, "");
  const fields = inputJson === undefined ? {} : (FIELDS[runtime]?.[tool]?.(inputJson) ?? {});
  const detail = detailOf(inputJson) ?? fields.command ?? (kind === "other" ? tool : undefined);
  return { kind, ...(detail === undefined ? {} : { detail }), ...fields };
}

const LABELS: Record<ToolActionKind, { running: string; done: string; failed: string }> = {
  run_command: { running: "Running command", done: "Ran command", failed: "Command failed" },
  read_file: { running: "Reading file", done: "Read file", failed: "Read failed" },
  edit_file: { running: "Editing file", done: "Edited file", failed: "Edit failed" },
  search: { running: "Searching", done: "Searched", failed: "Search failed" },
  web: { running: "Searching the web", done: "Searched the web", failed: "Web request failed" },
  mcp: { running: "Using a tool", done: "Used a tool", failed: "Tool failed" },
  wait: { running: "Waiting", done: "Waited", failed: "Wait failed" },
  other: { running: "Working", done: "Done", failed: "Failed" },
};

/** The human label for an action in a given lifecycle state; tense centralized here so events stay consistent. */
export function toolActionLabel(kind: ToolActionKind, state: "running" | "done" | "failed"): string {
  return LABELS[kind][state];
}
