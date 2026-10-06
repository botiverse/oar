import type { Runtime } from "@botiverse/oar";
import type { SendMode, SpawnOptions, Subagents } from "@botiverse/oar/agents";

/** One MCP tool: its listing and its handler over the subagent crew. */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** `signal` aborts when the client cancels the call or goes away. */
  readonly call: (args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<unknown>;
}

export class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

function text(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  if (value !== undefined && typeof value !== "string") {
    throw new ToolInputError(`${key} must be a string`);
  }
  return value;
}

function required(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = text(args, key);
  if (value === undefined || value === "") {
    throw new ToolInputError(`${key} is required`);
  }
  return value;
}

function spawnOptions(args: Readonly<Record<string, unknown>>): SpawnOptions {
  const optional = ["name", "cwd", "model", "effort", "resume"].flatMap((key) => {
    const value = text(args, key);
    return value === undefined ? [] : [[key, value] as const];
  });
  return { runtime: required(args, "runtime"), task: required(args, "task"), ...Object.fromEntries(optional) };
}

const SPAWN_PROPERTIES = {
  runtime: { type: "string", description: "Runtime id, from the runtimes tool (claude, codex, grok, kimi, opencode, antigravity, pi; cursor refuses the environment a subagent needs)." },
  task: { type: "string", description: "The task: everything the subagent needs, since it sees nothing of this conversation." },
  name: { type: "string", description: "A short name to refer to it by." },
  cwd: { type: "string", description: "Working directory; the server's by default." },
  model: { type: "string", description: "Runtime-native model id." },
  effort: { type: "string", description: "Runtime-native reasoning effort." },
  resume: { type: "string", description: "A sessionId from an earlier report, to continue that conversation." },
};

async function installed(runtimes: readonly Runtime[]): Promise<unknown[]> {
  const rows = await Promise.all(runtimes.map(async (runtime) => {
    const installation = await runtime.installation?.();
    // A child carries its depth in `env`, so a runtime that refuses `env` cannot be spawned.
    const envRefused = runtime.refusedSessionOptions?.env;
    return {
      runtime: runtime.id,
      installation: installation?.kind ?? "unknown",
      ...(installation?.kind === "available" && installation.via === "executable" && installation.version !== undefined ? { version: installation.version } : {}),
      ...(envRefused === undefined ? {} : { spawnable: false, reason: envRefused }),
    };
  }));
  return rows;
}

/** The tools `oar mcp` serves: a blocking `run`, and spawn/send/wait/list/interrupt/close for parallel work. */
export function subagentTools(crew: Subagents, runtimes: readonly Runtime[]): readonly McpTool[] {
  const agent = (args: Readonly<Record<string, unknown>>): NonNullable<ReturnType<Subagents["get"]>> => {
    const id = required(args, "id");
    const found = crew.get(id);
    if (found === undefined) {
      throw new ToolInputError(`no subagent ${id}; the list tool names them`);
    }
    return found;
  };
  const idOnly = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
  return [
    {
      name: "runtimes",
      description: "List the agent runtimes this server can start and whether each is installed.",
      inputSchema: { type: "object", properties: {} },
      call: async () => {
        const rows = await installed(runtimes);
        return rows;
      },
    },
    {
      name: "run",
      description: "Start a subagent on another agent runtime (or resume one) and wait until its turn ends; returns its final text, outcome and sessionId. Subagents run with full permissions in their working directory.",
      inputSchema: { type: "object", properties: SPAWN_PROPERTIES, required: ["runtime", "task"] },
      call: async (args, signal) => {
        const spawned = await crew.spawn(spawnOptions(args));
        if (spawned.kind === "refused") {
          return spawned;
        }
        // A cancelled call leaves the report unread, for wait or the next run.
        const report = await crew.next(spawned.agent.id, { signal });
        return report ?? spawned.agent.info();
      },
    },
    {
      name: "spawn",
      description: "Start a subagent and return at once with its id; read its result later with wait. Use for several tasks in parallel.",
      inputSchema: { type: "object", properties: SPAWN_PROPERTIES, required: ["runtime", "task"] },
      call: async (args) => {
        const spawned = await crew.spawn(spawnOptions(args));
        return spawned.kind === "refused" ? spawned : spawned.agent.info();
      },
    },
    {
      name: "send",
      description: "Send a subagent a message. followup (default) starts a turn when it is idle and steers its running turn otherwise; steer and queue are explicit.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, message: { type: "string" }, mode: { type: "string", enum: ["followup", "steer", "queue"] } },
        required: ["id", "message"],
      },
      call: async (args) => {
        const mode = text(args, "mode") ?? "followup";
        if (mode !== "followup" && mode !== "steer" && mode !== "queue") {
          throw new ToolInputError("mode must be followup, steer or queue");
        }
        const sendMode: SendMode = mode;
        const result = await agent(args).send(required(args, "message"), sendMode);
        return result;
      },
    },
    {
      name: "wait",
      description: "Wait for subagents' turns to end and return their reports (final text, outcome, sessionId). Returns at once when reports are unread; an empty list means none ended before the timeout.",
      inputSchema: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" } }, timeoutMs: { type: "number", description: "Default 30000, at most 600000." } },
      },
      call: async (args, signal) => {
        const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : undefined;
        const timeoutMs = typeof args.timeoutMs === "number" ? Math.min(Math.max(args.timeoutMs, 0), 600_000) : 30_000;
        const reports = await crew.wait({ ...(ids === undefined ? {} : { ids }), timeoutMs, signal });
        return reports;
      },
    },
    {
      name: "list",
      description: "List this server's subagents with their state and turns ended.",
      inputSchema: { type: "object", properties: {} },
      call: async () => {
        await Promise.resolve();
        return crew.list();
      },
    },
    {
      name: "interrupt",
      description: "Interrupt a subagent's running turn; its report follows with the outcome.",
      inputSchema: idOnly,
      call: async (args) => {
        const outcome = await agent(args).interrupt();
        return outcome;
      },
    },
    {
      name: "close",
      description: "Close a subagent and release its runtime process.",
      inputSchema: idOnly,
      call: async (args) => {
        await agent(args).close();
        return agent(args).info();
      },
    },
  ];
}
