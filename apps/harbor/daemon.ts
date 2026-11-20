import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve as resolvePath } from "node:path";
import { HarborAgent } from "./agent.js";
import { isOp, OPS } from "./contracts.js";
import { daemonInfo, mentionsIn, parseAgentEnv, parseAgentSpec, Store, type AgentState } from "./store.js";
import { directoryBytes, type AgentOptions } from "./support.js";

const HERE = import.meta.dirname;
const TSX = resolvePath(HERE, "../../node_modules/.bin/tsx");
const CLI = join(HERE, "harbor.ts");

type Body = Readonly<Record<string, unknown>>;
type Routes = Readonly<Record<string, (body: Body) => unknown>>;

export function field(body: Body, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" ? value : undefined;
}

export function asRecord(value: unknown): Body {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/**
 * The long-running host: opens every agent, routes channel messages to them,
 * runs the watchdog, and answers the CLI on a loopback port. Agents in
 * state.json are reopened with their recorded sessions, so `up` after a crash
 * or `down` is itself a resume test.
 */
export interface UpOptions {
  readonly stallMs: number;
  /** `name:KEY=VALUE` entries: environment for one agent (its probe and sessions). */
  readonly agentEnv: readonly string[];
  /** Stop on its own after this long (the run's deadline). */
  readonly forMs?: number;
  /** Stop when the run directory grows past this many bytes. */
  readonly maxBytes?: number;
  readonly recycle: AgentOptions["recycle"];
  readonly dayTokens: AgentOptions["dayTokens"];
}

export async function up(dir: string, specs: readonly string[], upOptions: UpOptions): Promise<void> {
  const { stallMs } = upOptions;
  if (daemonInfo(dir) !== null) {
    throw new Error(`a harbor daemon already runs for ${dir}`);
  }
  const store = new Store(dir);
  const states: AgentState[] = [...(store.state()?.agents ?? [])];
  for (const raw of specs) {
    const spec = parseAgentSpec(raw);
    if (!states.some((state) => state.name === spec.name)) {
      states.push({ ...spec, opens: 0 });
    }
  }
  for (const [name, env] of parseAgentEnv(upOptions.agentEnv)) {
    const index = states.findIndex((state) => state.name === name);
    const state = states[index];
    if (state === undefined) {
      throw new Error(`--agent-env names no agent ${name}`);
    }
    states[index] = { ...state, env: { ...state.env, ...env } };
  }
  if (states.length === 0) {
    throw new Error("no agents: pass --agent name=runtime[:model]");
  }
  const agents = new Map<string, HarborAgent>();
  const save = (): void => {
    store.saveState({ agents: [...agents.values()].map((agent) => agent.state) });
  };
  const addAgent = (state: AgentState): void => {
    const agent = new HarborAgent(state, store, { stallMs, bin: writeBin(dir, state.name), recycle: upOptions.recycle, dayTokens: upOptions.dayTokens }, save);
    agents.set(state.name, agent);
    save();
    void openReporting(agent);
  };
  let stopping = false;
  const startedAt = Date.now();
  let lastSizeCheck = 0;
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const agent of agents.values()) {
      agent.tick(now);
    }
    if (upOptions.forMs !== undefined && now - startedAt >= upOptions.forMs) {
      store.journal({ kind: "limit", limit: "deadline", forMs: upOptions.forMs });
      void stop();
    } else if (upOptions.maxBytes !== undefined && now - lastSizeCheck >= 300_000) {
      lastSizeCheck = now;
      const bytes = directoryBytes(dir);
      if (bytes > upOptions.maxBytes) {
        store.journal({ kind: "limit", limit: "disk", bytes, maxBytes: upOptions.maxBytes });
        void stop();
      }
    }
  }, 15_000);
  const server = createServer((request, response) => {
    void handle(routes, request, response);
  });
  const down = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearInterval(watchdog);
    store.journal({ kind: "down" });
    await Promise.allSettled([...agents.values()].map(async (agent) => {
      await agent.close();
    }));
    save();
    server.close();
    rmSync(join(dir, "daemon.json"), { force: true });
  };
  const stop = async (): Promise<void> => {
    await down();
    process.exit(0);
  };
  const routes: Routes = {
    "/send": (body) => {
      const from = field(body, "from") ?? "qa";
      const text = field(body, "text") ?? "";
      if (text.trim() === "") {
        throw new Error("empty message");
      }
      const mentioned = new Set(mentionsIn(text));
      const everyone = mentioned.has("all") || (mentioned.size === 0 && !agents.has(from));
      const to = [...agents.keys()].filter((name) => name !== from && (everyone || mentioned.has(name)));
      const message = store.post(from, text, to);
      agents.get(from)?.replied();
      for (const name of to) {
        agents.get(name)?.deliver(message, !agents.has(from));
      }
      return message;
    },
    "/status": () => {
      const now = Date.now();
      return { agents: [...agents.values()].map((agent) => agent.status(now)) };
    },
    "/add": (body) => {
      const spec = parseAgentSpec(field(body, "spec") ?? "");
      if (agents.has(spec.name)) {
        throw new Error(`agent ${spec.name} exists`);
      }
      addAgent({ ...spec, opens: 0 });
      return { added: spec.name };
    },
    "/restart": async (body) => {
      const name = field(body, "agent") ?? "";
      const agent = agents.get(name);
      if (agent === undefined) {
        throw new Error(`no agent ${name}`);
      }
      await agent.restart(body.fresh === true);
      return agent.status(Date.now());
    },
    "/op": async (body) => {
      const name = field(body, "agent") ?? "";
      const agent = agents.get(name);
      const op = field(body, "op") ?? "";
      if (agent === undefined) {
        throw new Error(`no agent ${name}`);
      }
      if (!isOp(op)) {
        throw new Error(`unknown op ${op}; one of ${OPS.join(", ")}`);
      }
      const result = await agent.op(op, field(body, "arg"));
      return result;
    },
    "/down": () => {
      setImmediate(() => {
        void stop();
      });
      return { stopping: true };
    },
  };
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  writeFileSync(join(dir, "daemon.json"), `${JSON.stringify({ pid: process.pid, port, startedAt: Date.now() })}\n`);
  store.journal({ kind: "up", pid: process.pid, port, agents: states.map((state) => state.name) });
  console.log(`harbor up: ${dir} (port ${port}); agents ${states.map((state) => state.name).join(", ")}`);
  for (const state of states) {
    addAgent(state);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stop();
    });
  }
}

async function openReporting(agent: HarborAgent): Promise<void> {
  try {
    await agent.open();
  } catch (error) {
    console.error(`${agent.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handle(routes: Routes, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const route = routes[request.url ?? ""];
  try {
    if (route === undefined) {
      throw new Error(`no route ${request.url ?? ""}`);
    }
    request.setEncoding("utf8");
    let text = "";
    for await (const chunk of request) {
      text += String(chunk);
    }
    const parsed: unknown = text === "" ? {} : JSON.parse(text);
    const result: unknown = await route(asRecord(parsed));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

/** An agent's own `harbor`: this CLI under tsx with the run and the sender fixed, so it needs nothing from the session's environment. */
function writeBin(dir: string, agent: string): string {
  const binDir = join(dir, "bin", agent);
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, "harbor");
  writeFileSync(file, `#!/bin/sh\nHARBOR_DIR=${JSON.stringify(dir)} HARBOR_AGENT=${JSON.stringify(agent)} exec ${JSON.stringify(TSX)} ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/** `up --detach`: the same daemon, in the background, logging to daemon.log. */
export function detach(dir: string, args: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  const log = openSync(join(dir, "daemon.log"), "a");
  const child = spawn(TSX, [CLI, "up", "--dir", dir, ...args.filter((arg) => arg !== "--detach")], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  console.log(`harbor daemon pid ${child.pid ?? "?"}; log ${join(dir, "daemon.log")}`);
}

export async function call(dir: string, path: string, body?: unknown): Promise<Body> {
  const info = daemonInfo(dir);
  if (info === null) {
    throw new Error(`no harbor daemon for ${dir}: run harbor up`);
  }
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
  const parsed: unknown = await response.json();
  const json = asRecord(parsed);
  if (!response.ok) {
    throw new Error(field(json, "error") ?? `HTTP ${response.status}`);
  }
  return json;
}
