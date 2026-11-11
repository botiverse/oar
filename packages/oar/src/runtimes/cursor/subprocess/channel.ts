import { spawnNodeScript, type NodeScriptExit } from "../../../shared/executable/node-script.js";
import { asRecord } from "../../../shared/json.js";
import { redactTokenShapes } from "../../../shared/token-redaction.js";
import { cursorChildLaunch } from "./child-script.js";

/** What the SDK in the child has, as it reported once loaded. */
export interface CursorChildFeatures {
  readonly auth: boolean;
  readonly logout: boolean;
  readonly store: boolean;
}

/** How the child ended, with a one-paragraph reason. */
export interface CursorChildExit {
  readonly code: number | null;
  readonly reason: string;
}

/** One cursor child: calls answered over its IPC channel. */
export interface CursorChannel {
  readonly features: CursorChildFeatures;
  /** A call to the child, named by `id`; `onEvent` receives the call's events (deltas, stream messages, login steps). */
  start(method: string, args: readonly unknown[], onEvent?: (value: unknown) => void): { readonly id: number; readonly reply: Promise<unknown> };
  /** `start`, awaiting the reply. */
  call(method: string, args: readonly unknown[], onEvent?: (value: unknown) => void): Promise<unknown>;
  /** Called once when the child exits, whether stopped or not. */
  onExit(listener: (exit: CursorChildExit) => void): void;
  /** True once `stop()` asked the child to end (after waiting for agent closes): an exit from then on was asked for. */
  stopping(): boolean;
  /** Waits for agent closes, asks the child to shut down, ends it and its descendants if it does not (`NodeScriptChild.stop`); settles with the exit. */
  stop(): Promise<CursorChildExit>;
}

/** How long the SDK may take to load in a fresh child (a cold import of the bundle). */
const READY_TIMEOUT_MS = 60_000;
/** How long stopping a child waits for the agent closes asked before it (the SDK's own async close work). */
const CLOSE_SETTLE_MS = 5000;
/** The stderr tail kept in an exit reason. */
const REASON_STDERR_CHARS = 1000;
/** Calls that end their events with their reply. */
const EVENTS_UNTIL_REPLY: ReadonlySet<string> = new Set(["stream", "login"]);

/** An error that crossed from the child as plain data: its name, message and scalar fields. */
export function childError(value: unknown): Error {
  const record = asRecord(value);
  const error = new Error(typeof record?.message === "string" ? record.message : "cursor's child process failed");
  for (const [key, field] of Object.entries(record ?? {})) {
    if (key !== "message" && (typeof field === "string" || typeof field === "number" || typeof field === "boolean")) {
      Object.defineProperty(error, key, { value: field, enumerable: key !== "name", writable: true, configurable: true });
    }
  }
  return error;
}

function exitReason(exit: NodeScriptExit): string {
  const how = exit.signal === null ? `code ${String(exit.code)}` : `signal ${exit.signal}`;
  const tail = exit.stderr.trim().slice(-REASON_STDERR_CHARS);
  return redactTokenShapes(tail === "" ? `cursor's SDK child process exited with ${how}` : `cursor's SDK child process exited with ${how}; stderr ends: ${tail}`);
}

function features(value: unknown): CursorChildFeatures {
  const record = asRecord(value);
  return { auth: record?.auth === true, logout: record?.logout === true, store: record?.store === true };
}

/**
 * Start a cursor child with `env` (the session's or call's whole
 * environment) and wait until it loaded the SDK from `sdkModule`. A child
 * that cannot load it, or exits first, is stopped and the open rejects.
 */
export async function openCursorChannel(sdkModule: string, env: Readonly<NodeJS.ProcessEnv>): Promise<CursorChannel> {
  const launch = cursorChildLaunch(sdkModule, env);
  const child = spawnNodeScript(launch.script, launch.argument, launch.env);
  const replies = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const events = new Map<number, (value: unknown) => void>();
  const exitListeners: ((exit: CursorChildExit) => void)[] = [];
  const ready = Promise.withResolvers<CursorChildFeatures>();
  let exit: CursorChildExit | null = null;
  let stopping = false;
  let next = 0;
  child.onMessage((raw) => {
    const message = asRecord(raw);
    const id = typeof message?.id === "number" ? message.id : -1;
    if (message?.t === "ready") {
      if (message.e === undefined) { ready.resolve(features(message.v)); } else { ready.reject(childError(message.e)); }
    } else if (message?.t === "event") {
      events.get(id)?.(message.v);
    } else if (message?.t === "reply") {
      const waiting = replies.get(id);
      replies.delete(id);
      if (message.e === undefined) { waiting?.resolve(message.v); } else { waiting?.reject(childError(message.e)); }
    }
  });
  void (async (): Promise<void> => {
    const ended = await child.exited;
    exit = { code: ended.code, reason: exitReason(ended) };
    const gone = new Error(exit.reason);
    ready.reject(gone);
    for (const waiting of replies.values()) { waiting.reject(gone); }
    replies.clear();
    events.clear();
    for (const listener of exitListeners.splice(0)) { listener(exit); }
  })();
  // Agent closes still on their way: the child is stopped after them.
  const closing = new Set<Promise<unknown>>();
  const stop = async (): Promise<CursorChildExit> => {
    if (closing.size > 0) {
      const settled = Promise.withResolvers<void>();
      const timer = setTimeout(settled.resolve, CLOSE_SETTLE_MS);
      await Promise.race([Promise.allSettled(closing), settled.promise]);
      clearTimeout(timer);
    }
    // From here on an exit is the one asked for; one before is a crash, with its reason.
    stopping = exit === null;
    // The child closes what is still open and exits on its own; the tree kill is the backstop.
    const ended = await child.stop(() => { child.send({ id: 0, m: "shutdown", a: [] }); });
    return exit ?? { code: ended.code, reason: exitReason(ended) };
  };
  const timer = setTimeout(() => { ready.reject(new Error(`cursor's SDK child process did not load ${sdkModule} within ${String(READY_TIMEOUT_MS / 1000)} s`)); }, READY_TIMEOUT_MS);
  let loaded: CursorChildFeatures | null = null;
  try {
    loaded = await ready.promise;
  } catch (error) {
    await stop();
    throw new Error(`cursor could not load @cursor/sdk in its child process: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
  const start: CursorChannel["start"] = (method, args, onEvent) => {
    next += 1;
    const id = next;
    if (exit !== null) { return { id, reply: Promise.reject(new Error(exit.reason)) }; }
    const reply = Promise.withResolvers<unknown>();
    replies.set(id, reply);
    if (onEvent !== undefined) { events.set(id, onEvent); }
    child.send({ id, m: method, a: args });
    if (method === "close") {
      closing.add(reply.promise);
      void (async (): Promise<void> => {
        try { await reply.promise; } catch { /* The caller sees it. */ } finally { closing.delete(reply.promise); }
      })();
    }
    if (!EVENTS_UNTIL_REPLY.has(method)) { return { id, reply: reply.promise }; }
    return { id, reply: (async (): Promise<unknown> => {
      try { return await reply.promise; } finally { events.delete(id); }
    })() };
  };
  return {
    features: loaded,
    start,
    async call(method, args, onEvent) {
      const value = await start(method, args, onEvent).reply;
      return value;
    },
    onExit(listener) {
      if (exit === null) { exitListeners.push(listener); } else { listener(exit); }
    },
    stopping: () => stopping,
    stop,
  };
}
