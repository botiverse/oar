import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "undici";
import { processFailure } from "../../shared/executable/diagnostics.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { asRecord, parseJson } from "../../shared/json.js";

/*
 * A morph Console owns one state directory: it takes `console/owner.lck`
 * there, and a second `morph console serve` on the same directory refuses to
 * start. While it runs, Console publishes a loopback Runtime API endpoint and
 * a private bearer token in `<state>/console/runtime.json` (mistermorph
 * cmd/mistermorph/consolecmd/local_chat.go); `morph chat` and
 * `morph console stop` find it there. OAR attaches to that Console when one is
 * running and starts one otherwise, shared by every session of this process
 * on the same directory and stopped when the last of them is released.
 */

/** How long a started Console may take to publish its endpoint. */
const CONSOLE_START_TIMEOUT_MS = 60_000;
const DISCOVERY_POLL_MS = 200;
const REQUEST_TIMEOUT_MS = 15_000;

/** The Runtime API endpoint a running Console publishes. */
export interface ConsoleEndpoint {
  readonly url: string;
  readonly token: string;
}

/** A Runtime API answer: the status, and the body as JSON when it is JSON, otherwise its text. */
export interface ConsoleReply {
  readonly status: number;
  readonly body: unknown;
}

export class ConsoleClient {
  readonly endpoint: ConsoleEndpoint;

  constructor(endpoint: ConsoleEndpoint) {
    this.endpoint = endpoint;
  }

  async call(method: string, route: string, body?: unknown): Promise<ConsoleReply> {
    const response = await fetch(`${this.endpoint.url}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.endpoint.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    const parsed = (response.headers.get("content-type") ?? "").includes("json") ? parseJson(text) : undefined;
    return { status: response.status, body: parsed ?? text.trim() };
  }

  /** A call whose non-2xx answer is an error carrying the Runtime API's message. */
  async expect(method: string, route: string, body?: unknown): Promise<unknown> {
    const reply = await this.call(method, route, body);
    if (reply.status < 200 || reply.status > 299) {
      throw new Error(`morph ${method} ${route} answered ${String(reply.status)}: ${replyMessage(reply)}`);
    }
    return reply.body;
  }

  /** One task's `/stream/ws` snapshots, each handed over parsed. */
  stream(taskId: string, onFrame: (frame: unknown) => void, onClose: () => void): () => void {
    const socket = new WebSocket(
      `${this.endpoint.url.replace(/^http/u, "ws")}/stream/ws?task_id=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${this.endpoint.token}` } },
    );
    socket.addEventListener("message", (event) => {
      const frame = parseJson(String(event.data));
      if (frame !== undefined) {
        onFrame(frame);
      }
    });
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", () => {
      // A close follows; the session decides there whether to reconnect.
    });
    return () => {
      socket.close();
    };
  }
}

export function replyMessage(reply: ConsoleReply): string {
  const record = asRecord(reply.body);
  if (typeof record?.error === "string") {
    return record.error;
  }
  return typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
}

/**
 * The state directory morph resolves: `MISTER_MORPH_FILE_STATE_DIR`, else a
 * top-level `file_state_dir` in its config file (`MISTER_MORPH_CONFIG`, else
 * `~/.morph/config.yaml`), else `~/.morph`.
 */
export function morphStateDir(env: Readonly<NodeJS.ProcessEnv> = process.env, home: string = homedir()): string {
  const expand = (dir: string): string => {
    if (dir === "~") {
      return home;
    }
    return dir.startsWith("~/") ? path.join(home, dir.slice(2)) : dir;
  };
  const fromEnv = env.MISTER_MORPH_FILE_STATE_DIR?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return expand(fromEnv);
  }
  const configured = env.MISTER_MORPH_CONFIG?.trim();
  const configPath = expand(configured === undefined || configured === "" ? path.join(home, ".morph", "config.yaml") : configured);
  if (existsSync(configPath)) {
    const match = /^file_state_dir:[ \t]*["']?([^"'#\r\n]*?)["']?[ \t]*(?:#.*)?$/mu.exec(readFileSync(configPath, "utf8"));
    const stateDir = match?.[1]?.trim();
    if (stateDir !== undefined && stateDir !== "") {
      return expand(stateDir);
    }
  }
  return path.join(home, ".morph");
}

function readEndpoint(stateDir: string): ConsoleEndpoint | null {
  const file = path.join(stateDir, "console", "runtime.json");
  if (!existsSync(file)) {
    return null;
  }
  const record = asRecord(parseJson(readFileSync(file, "utf8")));
  return typeof record?.url === "string" && typeof record.token === "string" ? { url: record.url.replace(/\/+$/u, ""), token: record.token } : null;
}

/** The Console published for `stateDir`, when one answers as a Console; a stale file from a dead one is not. */
export async function discoverConsole(stateDir: string): Promise<ConsoleClient | null> {
  const endpoint = readEndpoint(stateDir);
  if (endpoint === null) {
    return null;
  }
  const client = new ConsoleClient(endpoint);
  try {
    const health = await client.call("GET", "/health");
    return health.status === 200 && asRecord(health.body)?.mode === "console" ? client : null;
  } catch {
    return null;
  }
}

/** A session's hold on a Console: released once, after which the Console may stop. */
export interface ConsoleLease {
  readonly client: ConsoleClient;
  /** True when this process started the Console (it stops with the last lease). */
  readonly owned: boolean;
  /** Fires when an owned Console exits while held. Never fires for an attached one. */
  onExit(listener: (code: number | null) => void): void;
  /** Resolves with the Console's exit when this release stopped it, null when it keeps running. */
  release(): Promise<{ readonly code: number | null } | null>;
}

interface OwnedConsole {
  readonly child: LineProcess;
  readonly client: ConsoleClient;
  readonly listeners: Set<(code: number | null) => void>;
  holders: number;
}

const owned = new Map<string, Promise<OwnedConsole>>();

async function startConsole(command: string, stateDir: string): Promise<OwnedConsole> {
  // An ephemeral port: the Runtime API is found through runtime.json, and a
  // fixed port would collide with a Console the user starts later.
  const child = spawnLineProcess(command, ["console", "serve", "--console-listen", "127.0.0.1:0"], { cwd: stateDir });
  await child.spawned;
  const exit: { code?: number | null } = {};
  child.onExit((code) => {
    exit.code = code;
  });
  const deadline = Date.now() + CONSOLE_START_TIMEOUT_MS;
  for (;;) {
    const client = await discoverConsole(stateDir);
    if (client !== null) {
      const console: OwnedConsole = { child, client, listeners: new Set(), holders: 0 };
      child.onExit((code) => {
        owned.delete(stateDir);
        for (const listener of console.listeners) {
          listener(code);
        }
      });
      return console;
    }
    if ("code" in exit) {
      throw processFailure(`morph console serve exited before publishing ${path.join(stateDir, "console", "runtime.json")}`, child.diagnostics());
    }
    if (Date.now() > deadline) {
      child.kill();
      await child.exited;
      throw processFailure(`morph console serve did not publish its Runtime API within ${String(CONSOLE_START_TIMEOUT_MS)} ms`, child.diagnostics());
    }
    await delay(DISCOVERY_POLL_MS);
  }
}

/**
 * Hold the Console for `stateDir`: the one already running (attached, never
 * stopped by OAR), or one this process starts and shares until the last lease
 * is released. A Console the user started in the meantime wins the state
 * directory lock, and the start falls back to attaching to it.
 */
export async function acquireConsole(command: string, stateDir: string): Promise<ConsoleLease> {
  const pending = owned.get(stateDir);
  if (pending === undefined) {
    const running = await discoverConsole(stateDir);
    if (running !== null) {
      return attachedLease(running);
    }
  }
  let starting = owned.get(stateDir);
  if (starting === undefined) {
    starting = startConsole(command, stateDir);
    owned.set(stateDir, starting);
  }
  const console = await starting.catch(async (error: unknown) => {
    owned.delete(stateDir);
    const running = await discoverConsole(stateDir);
    if (running === null) {
      throw error;
    }
    return running;
  });
  if (console instanceof ConsoleClient) {
    return attachedLease(console);
  }
  console.holders += 1;
  let released = false;
  const mine = new Set<(code: number | null) => void>();
  return {
    client: console.client,
    owned: true,
    onExit(listener) {
      mine.add(listener);
      console.listeners.add(listener);
    },
    async release() {
      if (released) {
        return null;
      }
      released = true;
      for (const listener of mine) {
        console.listeners.delete(listener);
      }
      console.holders -= 1;
      if (console.holders > 0) {
        return null;
      }
      owned.delete(stateDir);
      console.child.kill();
      return { code: await console.child.exited };
    },
  };
}

function attachedLease(client: ConsoleClient): ConsoleLease {
  return {
    client,
    owned: false,
    onExit() {
      // Not ours: its exit shows up as unreachable calls instead.
    },
    release: async () => {
      await Promise.resolve();
      return null;
    },
  };
}
