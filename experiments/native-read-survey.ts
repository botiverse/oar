/**
 * Native query inventory, without prompts, thread/start, resume, or mutations.
 * Run: pnpm exec tsx experiments/native-read-survey.ts [all|codex|claude] [cwd]
 * OBSERVED 2026-09-16: Codex 0.154.0, Claude Code 2.1.273 on macOS.
 * Emits JSONL field names/types/counts, never response values or raw errors.
 * Runtime startup can still load plugins, connect MCP, and contact services.
 * A successful query proves availability on this connection, not all versions.
 */
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

interface Query {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly inspect?: readonly string[];
}
type Runtime = "codex" | "claude";
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return undefined;}
  return Object.fromEntries(Object.entries(value));
}

function at(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (Array.isArray(current)) {
      const entries: unknown[] = current;
      return entries[Number(key)];
    }
    return record(current)?.[key];
  }, value);
}

function describe(value: unknown): RecordValue {
  if (value === null) {return { type: "null" };}
  if (Array.isArray(value)) {
    const entries: unknown[] = value;
    return { type: "array", count: entries.length, firstItem: describe(entries[0]) };
  }
  const obj = record(value);
  return obj === undefined ? { type: typeof value } : { type: "object", fields: Object.keys(obj) };
}

function report(runtime: Runtime, query: Query, reply: RecordValue): void {
  const inner = runtime === "codex" ? reply : (record(reply.response) ?? {});
  const {error} = inner;
  const failed = error !== undefined || (runtime === "claude" && inner.subtype !== "success");
  const payload = runtime === "codex" ? inner.result : inner.response;
  const inspected = Object.fromEntries((query.inspect ?? []).map((path) => [path, describe(at(payload, path))]));
  const flags = query.method === "get_usage"
    ? { rateLimitsAvailable: record(payload)?.rate_limits_available === true }
    : {};
  process.stdout.write(`${JSON.stringify({
    runtime, method: query.method, outcome: failed ? "error" : "ok",
    ...(failed ? { errorCode: record(error)?.code ?? null, error: "omitted" }
      : { response: describe(payload), inspected, ...flags }),
  })}\n`);
}

function queries(runtime: Runtime, cwd: string): readonly Query[] {
  if (runtime === "claude") {return [
    { method: "initialize", inspect: ["commands", "agents", "models", "account"] },
    { method: "get_settings", inspect: ["effective", "sources", "applied"] },
    { method: "get_hooks_listing", inspect: ["events", "hooks", "policy"] },
    { method: "list_permission_rules", inspect: ["state.rules", "state.workspaceDirectories"] },
    { method: "mcp_status", inspect: ["mcpServers", "mcpServers.0.tools"] },
    { method: "get_context_usage", params: { detail: "summary" },
      inspect: ["categories", "memoryFiles", "mcpTools", "skills", "skills.skillFrontmatter", "messageBreakdown"] },
    { method: "get_usage", params: { skip_behaviors: true }, inspect: ["session", "rate_limits", "behaviors"] },
    { method: "get_session_cost" },
    { method: "get_memory_dialog", inspect: ["files", "folders", "auto_memory"] },
    { method: "get_plan" },
  ];}
  return [
    { method: "initialize", params: { clientInfo: { name: "oar_read_survey", version: "0.0.0" }, capabilities: { experimentalApi: true } } },
    { method: "config/read", params: { cwd, includeLayers: true }, inspect: ["config", "layers"] },
    { method: "configRequirements/read", inspect: ["requirements"] },
    { method: "skills/list", params: { cwds: [cwd] }, inspect: ["data", "data.0.skills", "data.0.errors"] },
    { method: "hooks/list", params: { cwds: [cwd] }, inspect: ["data", "data.0.hooks"] },
    { method: "mcpServerStatus/list", params: { limit: 10, detail: "toolsAndAuthOnly" }, inspect: ["data"] },
    { method: "thread/list", params: { limit: 1, cwd, useStateDbOnly: true }, inspect: ["data"] },
    { method: "thread/loaded/list", inspect: ["data"] },
    { method: "plugin/list", params: { cwds: [cwd], marketplaceKinds: ["local"] }, inspect: ["marketplaces", "marketplaces.0.plugins", "marketplaceLoadErrors"] },
    { method: "account/usage/read", inspect: ["summary", "dailyUsageBuckets", "threadUsage"] },
    { method: "permissionProfile/list", inspect: ["data"] },
  ];
}

async function probe(runtime: Runtime, cwd: string): Promise<void> {
  const command = process.env[runtime === "codex" ? "OAR_CODEX_BIN" : "OAR_CLAUDE_BIN"] ?? runtime;
  const version = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  process.stdout.write(`${JSON.stringify({ runtime, version })}\n`);
  const args = runtime === "codex" ? ["app-server", "--listen", "stdio://"]
    : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  const { promise: exited, resolve: onExit } = Promise.withResolvers<void>();
  let pending: { id: string; resolve: (reply: RecordValue) => void; reject: (error: Error) => void } | undefined = undefined;
  const disconnected = (): void => { pending?.reject(new Error("Runtime disconnected")); onExit(); };
  child.once("error", disconnected);
  child.once("close", disconnected);
  child.stdin.on("error", () => { pending?.reject(new Error("Runtime stdin closed")); });
  lines.on("line", (line) => {
    let parsed: unknown = null;
    try { parsed = JSON.parse(line); } catch { return; }
    const message = record(parsed);
    if (message === undefined) {return;}
    const id = runtime === "codex" ? message.id : record(message.response)?.request_id;
    if (pending !== undefined && id === pending.id) {pending.resolve(message);}
  });
  const write = (value: unknown): void => { child.stdin.write(`${JSON.stringify(value)}\n`); };
  const read = async (query: Query, index: number): Promise<void> => {
    const id = String(index);
    const { promise, resolve: accept, reject } = Promise.withResolvers<RecordValue>();
    pending = { id, resolve: accept, reject };
    const timer = setTimeout(() => { reject(new Error("Query timed out")); }, 20_000);
    try {
      write(runtime === "codex" ? { id, method: query.method, params: query.params ?? {} }
        : { type: "control_request", request_id: id, request: { subtype: query.method, ...query.params } });
      const reply = await promise;
      report(runtime, query, reply);
      if (runtime === "codex" && query.method === "initialize") {write({ method: "initialized", params: {} });}
    } finally { clearTimeout(timer); pending = undefined; }
  };
  try {
    // Each query must follow initialize and finish before the next is sent.
    await queries(runtime, cwd).reduce<Promise<void>>(async (previous, query, index) => {
      await previous;
      await read(query, index);
    }, Promise.resolve());
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
    const forceKill = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
    await exited;
    clearTimeout(forceKill);
  }
}

function probeClaudeCommands(): void {
  const command = process.env.OAR_CLAUDE_BIN ?? "claude";
  for (const args of [["plugin", "list", "--json"], ["agents", "--json"]]) {
    const text = execFileSync(command, args, { encoding: "utf8", cwd, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
    const value: unknown = JSON.parse(text);
    process.stdout.write(`${JSON.stringify({ runtime: "claude", command: args.join(" "), response: describe(value) })}\n`);
  }
}

const selected = process.argv[2] ?? "all";
const cwd = resolve(process.argv[3] ?? process.cwd());
if (selected !== "all" && selected !== "codex" && selected !== "claude") {
  throw new Error("Usage: native-read-survey.ts [all|codex|claude] [cwd]");
}
if (selected === "all" || selected === "codex") {await probe("codex", cwd);}
if (selected === "all" || selected === "claude") {await probe("claude", cwd); probeClaudeCommands();}
