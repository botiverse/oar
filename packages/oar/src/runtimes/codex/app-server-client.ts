// BYOK change: Modified from OAR 95c6547 for injected processes, a sticky terminal error and server replies (Apache-2.0).
// BYOK change: The caller owns process creation and must enforce bounded kill/exited semantics.
export interface LineProcess {
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  write(text: string): void;
  writeAcknowledged(text: string): Promise<void>; // BYOK change: native reply write receipt.
  kill(): void;
  exitError?(): Error; // BYOK change: bounded transport diagnostic, never used as a semantic classifier.
}
export type SpawnLineProcess = (
  command: string,
  args: readonly string[],
  options: { readonly env: Readonly<Record<string, string>>; readonly cwd?: string },
) => LineProcess;
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { nativeErrorCause } from "../../shared/native-error.js";
import { redactError } from "../../shared/mcp-servers.js";
// BYOK change: Keep startup synchronous at the injected spawn seam; do not use the upstream queued-client wrapper.
// BYOK change: Use caller-owned exitError diagnostics instead of shared/executable processFailure.
// BYOK change: The injected LineProcess has no resources reader, so the client omits upstream `resources`.

/**
 * Minimal persistent JSON-RPC client over codex app-server's stdio JSONL
 * transport. Local to the codex runtime until a second consumer earns a
 * shared promotion; process mechanics are injected by the caller. // BYOK change
 */
/** How a request settled, delivered synchronously as the reply line is read. */
export type RpcOutcome =
  | { readonly kind: "result"; readonly result: JsonRecord }
  | { readonly kind: "error"; readonly error: Error; readonly native?: JsonRecord }
  | { readonly kind: "exited"; readonly error: Error };

export interface AppServerHandlers {
  readonly onNotification: (method: string, params: JsonRecord) => void;
  // BYOK change: JSON-RPC server ids retain their original wire type.
  readonly onServerRequest: (id: number | string, method: string, params: JsonRecord) => void;
}

export interface AppServerClient {
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  /**
   * Send a request. `onSettled`, when given, runs SYNCHRONOUSLY at the moment
   * the reply line (or the exit) is processed, before any later line in the
   * same chunk, so a caller can record the reply in stream order; the
   * returned promise settles afterwards, on the microtask queue.
   */
  request(method: string, params: JsonRecord, onSettled?: (outcome: RpcOutcome) => void): Promise<JsonRecord>;
  notify(method: string, params: JsonRecord): void;
  // BYOK change: Answer server requests without coercing their ids.
  respond(id: number | string, result: unknown): Promise<void>;
  rejectRequest(id: number | string, code: number, message: string): Promise<void>;
  /**
   * Register the inbound handlers, once. Notifications and server-initiated
   * requests (frames with both `id` and `method`: approvals, user input,
   * dynamic tools; BYOK change: caller answers through respond/rejectRequest)
   * that arrive before this
   * call (the app-server talks right after `initialize`, before the thread
   * exists) are held in ONE queue and delivered here synchronously, in wire
   * order across both kinds: nothing the server said is lost or reordered
   * by registration timing.
   */
  handle(handlers: AppServerHandlers): void;
  /**
   * Place a callback in wire order: while frames are still being held (before
   * `handle`) it joins the held queue and runs at flush, after every frame
   * read before it and before every frame read after; once released it runs
   * immediately. Called from a request's synchronous `onSettled`, it pins a
   * record exactly where the reply sat on the wire.
   */
  mark(callback: () => void): void;
  onExit(handler: (code: number | null, reason?: string) => void): void;
  kill(): void;
}

interface Pending {
  readonly method: string;
  resolve(result: JsonRecord): void;
  reject(error: Error): void;
  settled(outcome: RpcOutcome): void;
}

/** How the app-server process is handled. BYOK change: the caller's spawn owns stderr and the process tree. */
export interface AppServerProcessOptions {
  /** Applied to the text of every error the client reports (codex's error message, the exit's stderr tail): a session's MCP credentials must never reach one. */
  readonly redact?: (text: string) => string;
  /** The host's own `app-server` arguments (SessionOptions.launchArgs), unchecked, after oar's `-c` overrides and before `--listen`. */
  readonly launchArgs?: readonly string[];
}

export function startAppServerClient(
  spawnLineProcess: SpawnLineProcess, // BYOK change: no second process manager.
  command: string,
  env: Readonly<Record<string, string>>, // BYOK change: explicit filtered environment required.
  configOverrides: Readonly<Record<string, string>> = {},
  cwd?: string,
  processOptions: AppServerProcessOptions = {},
): AppServerClient {
  // -c KEY=VALUE injects config at launch, for every thread of this process
  // (session.ts sets sandbox_mode this way). thread/start can also set the
  // sandbox per thread, but its field is `sandbox`: an unknown field such as
  // `sandboxMode` is ignored without an error.
  const overrideArgs = Object.entries(configOverrides).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const launchArgs = processOptions.launchArgs ?? [];
  const child = spawnLineProcess(
    command,
    ["app-server", ...overrideArgs, ...launchArgs, "--listen", "stdio://"],
    // BYOK change: upstream killTree is not passed. The caller-owned spawn owns tree termination.
    { ...(cwd === undefined ? {} : { cwd }), env }, // BYOK change: preserve filtered env verbatim.
  );
  // Session initialization observes spawn failures through its pending RPC.
  // Mark this parallel promise handled while preserving its rejection for
  // callers that explicitly await spawned.
  // oxlint-disable-next-line promise/prefer-await-to-then -- client construction remains synchronous
  void child.spawned.catch(() => {});
  const pending = new Map<number, Pending>();
  // Inbound frames and marks share one queue until `handle` registers the
  // handlers, so their relative order is the wire's whatever kind they are.
  const held: ((handlers: AppServerHandlers) => void)[] = [];
  let handlers: AppServerHandlers | null = null;
  const deliver = (delivery: (handlers: AppServerHandlers) => void): void => {
    if (handlers === null) {
      held.push(delivery);
    } else {
      delivery(handlers);
    }
  };
  let nextId = 1;
  // BYOK change: An exit or a kill sets one sticky terminal error. It settles every pending request as
  // `exited` at once, rejects later work and ignores later lines, even before a killed process has exited.
  let terminalError: Error | null = null;
  const terminate = (error: Error): void => {
    if (terminalError !== null) return;
    terminalError = error;
    const waiters = [...pending.values()];
    pending.clear();
    for (const waiter of waiters) {
      waiter.settled({ kind: "exited", error });
      waiter.reject(error);
    }
  };
  const redact = processOptions.redact ?? ((text: string): string => text);

  child.onLine((line) => {
    if (terminalError !== null) return; // BYOK change: ignore frames after the terminal error.
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    const hasId = typeof message.id === "number" || typeof message.id === "string";
    if (typeof message.method === "string") {
      const params = asRecord(message.params) ?? {};
      const { method } = message;
      if (hasId) {
        const id = message.id as number | string; // BYOK change: preserve the validated original id.
        deliver((target) => {
          target.onServerRequest(id, method, params);
        });
      } else {
        deliver((target) => {
          target.onNotification(method, params);
        });
      }
      return;
    }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      if (waiter === undefined) { return; }
      pending.delete(message.id);
      const error = asRecord(message.error);
      if (error !== null) {
        const cause = nativeErrorCause(waiter.method, error, redact);
        const failure = new Error(redact(typeof error.message === "string" ? error.message : "app-server error"), { cause });
        waiter.settled({ kind: "error", error: failure, native: cause.native });
        waiter.reject(failure);
      } else {
        const result = asRecord(message.result) ?? {};
        waiter.settled({ kind: "result", result });
        waiter.resolve(result);
      }
    }
  });
  child.onExit(() => {
    // BYOK change: the bounded exit error carries the stderr tail, so it is redacted.
    // The owned transport reports the exit after stdout closed, so no reply can follow it.
    terminate(redactError(child.exitError?.() ?? new Error("app-server exited"), redact) as Error);
  });

  return {
    spawned: child.spawned,
    exited: child.exited,
    async request(method, params, onSettled) {
      const settled = onSettled ?? ((): void => {});
      if (terminalError !== null) {
        const error = terminalError;
        settled({ kind: "exited", error });
        throw error;
      }
      const id = nextId;
      nextId += 1;
      // oxlint-disable-next-line promise/avoid-new -- settlement is driven by the response pump
      const result = await new Promise<JsonRecord>((resolve, reject) => {
        pending.set(id, { method, resolve, reject, settled });
        child.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      return result;
    },
    notify(method, params) {
      if (terminalError !== null) throw terminalError; // BYOK change: no writes after the terminal error.
      child.write(`${JSON.stringify({ method, params })}\n`);
    },
    // BYOK change: JSON-RPC results and errors echo numeric/string ids unchanged, through the acknowledged write.
    respond(id, result) {
      if (terminalError !== null) throw terminalError;
      return child.writeAcknowledged(`${JSON.stringify({ id, result })}\n`);
    },
    rejectRequest(id, code, message) {
      if (terminalError !== null) throw terminalError;
      return child.writeAcknowledged(`${JSON.stringify({ id, error: { code, message } })}\n`);
    },
    handle(registered) {
      if (terminalError !== null) throw terminalError; // BYOK change: do not replay a terminated stream.
      if (handlers !== null) {
        throw new Error("app-server handlers are already registered");
      }
      handlers = registered;
      for (const delivery of held.splice(0)) {
        delivery(registered);
      }
    },
    mark(callback) {
      deliver(() => {
        callback();
      });
    },
    onExit(handler) {
      child.onExit(handler);
    },
    kill() {
      terminate(new Error("app-server killed")); // BYOK change: do not await an exit to release pending state.
      child.kill();
    },
  };
}
