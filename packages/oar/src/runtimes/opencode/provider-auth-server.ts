import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { LoginSecrets, spawnLoginProcess, type LoginProcess } from "../../shared/login.js";
import { OpencodeProviderAuthError } from "./provider-auth-error.js";

/*
 * One owned `opencode serve` (2.2.7: `server listening on http://HOST:PORT`
 * on stdout; with OPENCODE_PASSWORD set it prints no password line). Basic
 * auth user `opencode` (2.2.7 reads no username variable), password chosen
 * here and passed only in the child's environment. Started on first use,
 * shared by concurrent operations, and stopped `idleMs` after the last one
 * ends or on close(). It runs under a watchdog, so it also stops when the
 * host dies, SIGKILL included (shared/executable/host-watchdog.ts).
 */

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface ApiResponse {
  readonly status: number;
  /** Parsed JSON; undefined for an empty or non-JSON body. */
  readonly body: unknown;
}

export type ApiCall = (method: HttpMethod, path: string, body?: unknown) => Promise<ApiResponse>;

export interface OpencodeServerOptions {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** One budget for startup and readiness together, and the bound for each request. */
  readonly timeoutMs: number;
  readonly idleMs: number;
  /** Readiness poll interval while the registry loads. */
  readonly pollMs: number;
}

interface Running {
  readonly url: string;
  readonly authorization: string;
  exited: boolean;
}

const LISTENING = /^server listening on (https?:\/\/\S+)/u;

// OpenCode's error tag, e.g. `InvalidRequestError`.
const TAG = "_tag";

/** OpenCode's own error JSON (`{_tag, message}`) as one redacted line. */
export function nativeDetail(response: ApiResponse, secrets: LoginSecrets): string {
  const record = asRecord(response.body);
  const tag = record?.[TAG];
  const message = typeof record?.message === "string" ? secrets.line(record.message) : undefined;
  return [`HTTP ${String(response.status)}`, typeof tag === "string" ? tag : undefined, message].filter((part) => part !== undefined && part !== "").join(": ");
}

/**
 * The serve child's environment: the caller's, with OAR's password, no
 * inherited OpenCode 1 username (2.2.7 has a fixed user), and no update
 * check or model-catalog fetch (OPENCODE_DISABLE_AUTOUPDATE and
 * OPENCODE_DISABLE_MODELS_FETCH, both read by 2.2.7). On POSIX, BROWSER is a
 * command that does nothing, so OpenCode can never open a browser on the
 * machine it runs on; Windows has no such command and keeps the caller's.
 */
export function serveEnvironment(env: NodeJS.ProcessEnv, password: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const inherited = { ...env };
  delete inherited.OPENCODE_SERVER_USERNAME;
  return {
    ...inherited,
    // OpenCode reads OPENCODE_PASSWORD first, then OPENCODE_SERVER_PASSWORD.
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    ...(platform === "win32" ? {} : { BROWSER: "true" }),
  };
}

function listed(response: ApiResponse): boolean {
  const data: unknown = asRecord(response.body)?.data;
  return response.status === 200 && Array.isArray(data) && data.length > 0;
}

export class OpencodeServer {
  readonly #options: OpencodeServerOptions;
  #running: Promise<Running> | undefined;
  #users = 0;
  #idle: NodeJS.Timeout | undefined;
  #generation = 0;
  #child: LoginProcess | undefined;
  #stopped: Promise<unknown> = Promise.resolve();

  constructor(options: OpencodeServerOptions) {
    this.#options = options;
  }

  /** Run `work` against a ready server, starting one when none runs. */
  async run<T>(work: (call: ApiCall) => Promise<T>): Promise<T> {
    clearTimeout(this.#idle);
    this.#users += 1;
    try {
      this.#running ??= this.#open(this.#generation);
      const running = await this.#running;
      return await work(async (method, path, body) => {
        const response = await this.#request(running, method, path, body);
        return response;
      });
    } finally {
      this.#users -= 1;
      if (this.#users === 0) {
        this.#idle = setTimeout(() => { void this.close(); }, this.#options.idleMs);
        // Waiting to stop an idle server must not keep the host process alive.
        this.#idle.unref();
      }
    }
  }

  /** Stop the server and everything it started; the next operation starts a new one. */
  async close(): Promise<void> {
    clearTimeout(this.#idle);
    this.#generation += 1;
    this.#running = undefined;
    const child = this.#child;
    if (child !== undefined) {
      this.#child = undefined;
      child.stop();
      this.#stopped = child.exited;
    }
    await this.#stopped;
  }

  /** A timeout answers immediately; explicit close still joins the same teardown. */
  async closeAfterError(error: unknown): Promise<void> {
    const stopped = this.close();
    if (!(error instanceof OpencodeProviderAuthError && error.kind === "timed_out")) {
      await stopped;
    }
  }

  async #open(generation: number): Promise<Running> {
    const { timeoutMs } = this.#options;
    try {
      return await withQueryDeadline("OpenCode server startup", timeoutMs, async signal => {
        // Waiting for an earlier server to exit consumes the same startup budget.
        await this.#stopped;
        signal.throwIfAborted();
        if (generation !== this.#generation) {
          throw new OpencodeProviderAuthError("startup_failed", "OpenCode's server was closed before startup");
        }
        const running = await this.#start(signal);
        if (generation !== this.#generation) {
          throw new OpencodeProviderAuthError("startup_failed", "OpenCode's server closed during startup");
        }
        return running;
      });
    } catch (error) {
      const failure = error instanceof DOMException && error.name === "TimeoutError"
        ? new OpencodeProviderAuthError("timed_out", `OpenCode's server was not ready within ${String(timeoutMs)} ms`) : error;
      if (generation === this.#generation) { await this.closeAfterError(failure); }
      throw failure;
    }
  }

  async #start(signal: AbortSignal): Promise<Running> {
    const { command, env, cwd } = this.#options;
    const password = randomBytes(24).toString("base64url");
    const secrets = new LoginSecrets();
    secrets.add(password);
    const listening = Promise.withResolvers<string>();
    const said = { first: "" };
    const child = spawnLoginProcess(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], serveEnvironment(env, password), {
      onLine: (line) => {
        const url = LISTENING.exec(line)?.[1];
        if (url !== undefined) {
          listening.resolve(url);
        }
        if (said.first === "") {
          said.first = line;
        }
      },
    }, { cwd, stopWithHost: true });
    this.#child = child;
    void (async (): Promise<void> => {
      const exit = await child.exited;
      if (this.#child === child) {
        this.#generation += 1;
        this.#child = undefined;
        this.#running = undefined;
      }
      const words = said.first === "" ? "" : `: ${secrets.line(said.first)}`;
      listening.reject(new OpencodeProviderAuthError("startup_failed", `opencode serve exited (${exit.error ?? `code ${String(exit.exitCode)}`})${words}`));
    })();
    const url = await listening.promise;
    const running: Running = { url, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, exited: false };
    void (async (): Promise<void> => {
      await child.exited;
      running.exited = true;
    })();
    await this.#ready(running, signal);
    return running;
  }

  /** Wait for initial catalogs. From 2.4.0, package plugins can still be loading
   * when both lists contain rows, so the cached login menu can miss their integrations. */
  async #ready(running: Running, signal: AbortSignal): Promise<void> {
    for (;;) {
      const plugins = await this.#request(running, "GET", "/api/plugin", undefined, signal);
      const integrations = await this.#request(running, "GET", "/api/integration", undefined, signal);
      if (listed(plugins) && listed(integrations)) { return; }
      if (running.exited) { throw new OpencodeProviderAuthError("startup_failed", "opencode serve exited before its integrations loaded"); }
      await delay(this.#options.pollMs, undefined, { signal });
    }
  }

  async #request(running: Running, method: HttpMethod, path: string, body?: unknown, signal = AbortSignal.timeout(this.#options.timeoutMs)): Promise<ApiResponse> {
    const parsed = await this.#fetch(running, method, path, body, signal);
    if (parsed.status === 401) {
      // 2.2.7: `{"_tag":"UnauthorizedError","message":"Authentication required"}` for a wrong or missing password.
      throw new OpencodeProviderAuthError("authentication_failed", `OpenCode's server refused OAR's password (${nativeDetail(parsed, new LoginSecrets())})`, 401);
    }
    return parsed;
  }

  async #fetch(running: Running, method: HttpMethod, path: string, body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    try {
      const response = await fetch(`${running.url}${path}`, {
        method,
        headers: { authorization: running.authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      const textBody = await response.text();
      return { status: response.status, body: textBody === "" ? undefined : parseJson(textBody) };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      // Never the request body: it may carry a key.
      throw new OpencodeProviderAuthError(timedOut ? "timed_out" : "server_failed", `${method} ${path} ${timedOut ? `timed out after ${String(this.#options.timeoutMs)} ms` : "failed: OpenCode's server did not answer"}`);
    }
  }
}
