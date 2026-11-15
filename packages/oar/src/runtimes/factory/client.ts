import { randomUUID } from "node:crypto";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { processFailure } from "../../shared/executable/diagnostics.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { nativeErrorCause } from "../../shared/native-error.js";
import type { SessionResources } from "../../contracts/session.js";

/*
 * Factory droid's own programmatic interface (droid 1.12.1, protocol
 * 1.340.0; docs/runtimes/factory.md): `droid exec --input-format
 * stream-jsonrpc --output-format stream-jsonrpc`, one JSON message per line,
 * JSON-RPC 2.0 plus Factory's `type` discriminator ("request", "response",
 * "notification") and `factoryApiVersion` on every message. Ids are strings.
 * One process serves one current session; no method names it.
 */
export const FACTORY_API_VERSION = "1.0.0";

/** How a request settled, delivered synchronously as the reply line is read. */
export type DroidOutcome =
  | { readonly kind: "result"; readonly result: JsonRecord; readonly native: JsonRecord }
  | { readonly kind: "error"; readonly error: Error; readonly native: JsonRecord }
  | { readonly kind: "exited"; readonly error: Error };

export interface DroidHandlers {
  /** Every notification line, whole: `droid.session_notification` and others. */
  readonly onNotification: (message: JsonRecord) => void;
  /** A droid→client request (`droid.request_permission`, `droid.ask_user`, ...), whole. */
  readonly onServerRequest: (message: JsonRecord) => void;
}

export interface DroidClient {
  readonly exited: Promise<number | null>;
  /**
   * Send a request. `onSettled` runs synchronously when the reply line (or
   * the exit) is processed, before any later line, so the caller can record
   * the reply in wire order; the returned promise settles afterwards.
   */
  request(method: string, params: JsonRecord, onSettled?: (outcome: DroidOutcome) => void, id?: string): Promise<JsonRecord>;
  /** Answer a droid→client request by its native id. */
  respond(id: unknown, reply: { readonly result: JsonRecord } | { readonly error: { readonly code: number; readonly message: string } }): void;
  /** Register the inbound handlers once; lines read before are delivered here, in wire order. */
  handle(handlers: DroidHandlers): void;
  /** Run a callback in wire order: before `handle`, it joins the held lines and runs at their flush. Called from `onSettled`, it pins a record where the reply sat. */
  mark(callback: () => void): void;
  onExit(handler: (code: number | null, reason?: string) => void): void;
  /** Close stdin (droid then ends its session and exits), escalating to signals after a grace period. */
  kill(): void;
  readonly resources: () => Promise<SessionResources | null>;
}

interface Pending {
  readonly method: string;
  resolve(result: JsonRecord): void;
  reject(error: Error): void;
  settled(outcome: DroidOutcome): void;
}

export interface DroidClientOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Applied to error text and native error causes: MCP credentials from the open must never reach one. */
  readonly redact?: (text: string) => string;
  /** The host's own arguments (`SessionOptions.launchArgs`), after oar's. */
  readonly launchArgs?: readonly string[];
}

export const DROID_EXEC_ARGS = ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"] as const;

export function startDroidClient(command: string, options: DroidClientOptions): DroidClient {
  const child = spawnLineProcess(command, [...DROID_EXEC_ARGS, ...(options.launchArgs ?? [])], {
    cwd: options.cwd, env: options.env, killTree: true, shutdown: "stdin",
  });
  // oxlint-disable-next-line promise/prefer-await-to-then -- construction stays synchronous; requests observe spawn failure.
  void child.spawned.catch(() => {});
  const redact = options.redact ?? ((text: string): string => text);
  const pending = new Map<string, Pending>();
  const held: ((handlers: DroidHandlers) => void)[] = [];
  let handlers: DroidHandlers | null = null;
  const deliver = (delivery: (target: DroidHandlers) => void): void => {
    if (handlers === null) { held.push(delivery); } else { delivery(handlers); }
  };
  let exitFailure: Error | null = null;

  child.onLine((line) => {
    const message = asRecord(parseJson(line));
    if (message === null) { return; }
    if (message.type === "response" && typeof message.id === "string") {
      const waiter = pending.get(message.id);
      if (waiter === undefined) { return; }
      pending.delete(message.id);
      const error = asRecord(message.error);
      if (error !== null) {
        const cause = nativeErrorCause(waiter.method, error, redact);
        const failure = new Error(redact(typeof error.message === "string" ? error.message : `${waiter.method} failed`), { cause });
        waiter.settled({ kind: "error", error: failure, native: message });
        waiter.reject(failure);
      } else {
        const result = asRecord(message.result) ?? {};
        waiter.settled({ kind: "result", result, native: message });
        waiter.resolve(result);
      }
      return;
    }
    if (message.type === "request") {
      deliver((target) => { target.onServerRequest(message); });
      return;
    }
    deliver((target) => { target.onNotification(message); });
  });
  child.onExit(() => {
    const diagnostics = child.diagnostics();
    exitFailure = processFailure("droid exited", {
      ...diagnostics,
      stderr: redact(diagnostics.stderr),
      ...(diagnostics.error === undefined ? {} : { error: { ...diagnostics.error, message: redact(diagnostics.error.message) } }),
    });
    for (const waiter of pending.values()) {
      waiter.settled({ kind: "exited", error: exitFailure });
      waiter.reject(exitFailure);
    }
    pending.clear();
  });

  const write = (message: JsonRecord): void => {
    child.write(`${JSON.stringify({ jsonrpc: "2.0", factoryApiVersion: FACTORY_API_VERSION, ...message })}\n`);
  };
  return {
    exited: child.exited,
    async request(method, params, onSettled, id = randomUUID()) {
      const settled = onSettled ?? ((): void => {});
      if (exitFailure !== null) {
        settled({ kind: "exited", error: exitFailure });
        throw exitFailure;
      }
      const { promise, resolve, reject } = Promise.withResolvers<JsonRecord>();
      pending.set(id, { method, resolve, reject, settled });
      write({ type: "request", id, method, params });
      const result = await promise;
      return result;
    },
    respond(id, reply) { write({ type: "response", id, ...reply }); },
    handle(registered) {
      if (handlers !== null) { throw new Error("droid handlers are already registered"); }
      handlers = registered;
      for (const delivery of held.splice(0)) { delivery(registered); }
    },
    mark(callback) { deliver(() => { callback(); }); },
    onExit(handler) { child.onExit(handler); },
    kill() { child.kill(); },
    resources: child.resources,
  };
}
