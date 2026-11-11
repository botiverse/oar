import { randomBytes } from "node:crypto";
import { asRecord, parseJson } from "../../shared/json.js";
import { LoginSecrets, spawnLoginProcess, type LoginProcess } from "../../shared/login.js";
import { OpencodeProviderAuthError } from "./provider-auth-error.js";

/*
 * One owned `opencode serve` (2.2.7: `server listening on http://HOST:PORT`
 * on stdout; with OPENCODE_PASSWORD set it prints no password line). Basic
 * auth user `opencode`, password chosen here and passed only in the child's
 * environment. Started on first use, shared by concurrent operations, and
 * stopped `idleMs` after the last one ends or on close().
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
  /** Bound for startup and readiness, and for each request. */
  readonly timeoutMs: number;
  readonly idleMs: number;
  /** Readiness poll interval while the registry loads. */
  readonly pollMs: number;
}

interface Running {
  readonly process: LoginProcess;
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

function listed(response: ApiResponse): boolean {
  const data: unknown = asRecord(response.body)?.data;
  return response.status === 200 && Array.isArray(data) && data.length > 0;
}

export class OpencodeServer {
  readonly #options: OpencodeServerOptions;
  #running: Promise<Running> | undefined;
  #users = 0;
  #idle: NodeJS.Timeout | undefined;

  constructor(options: OpencodeServerOptions) {
    this.#options = options;
  }

  /** Run `work` against a ready server, starting one when none runs. */
  async run<T>(work: (call: ApiCall) => Promise<T>): Promise<T> {
    clearTimeout(this.#idle);
    this.#users += 1;
    try {
      const running = await this.#ensure();
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
    const running = this.#running;
    this.#running = undefined;
    if (running === undefined) {
      return;
    }
    try {
      const settled = await running;
      settled.process.stop();
      await settled.process.exited;
    } catch {
      // A failed start already stopped its process.
    }
  }

  async #ensure(): Promise<Running> {
    // Another caller may replace an exited server while this one waits.
    for (let current = this.#running; current !== undefined; current = this.#running) {
      const running = await current;
      if (!running.exited) {
        return running;
      }
      if (this.#running === current) {
        this.#running = undefined;
      }
    }
    const started = this.#start();
    this.#running = started;
    try {
      return await started;
    } catch (error) {
      // A failed start leaves nothing to reuse.
      if (this.#running === started) { this.#running = undefined; }
      throw error;
    }
  }

  async #start(): Promise<Running> {
    const { command, env, cwd, timeoutMs, pollMs } = this.#options;
    const password = randomBytes(24).toString("base64url");
    const secrets = new LoginSecrets();
    secrets.add(password);
    const listening = Promise.withResolvers<string>();
    const said = { first: "" };
    const child = spawnLoginProcess(command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      ...env,
      // OpenCode reads OPENCODE_PASSWORD first, then OPENCODE_SERVER_PASSWORD.
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
    }, {
      onLine: (line) => {
        const url = LISTENING.exec(line)?.[1];
        if (url !== undefined) {
          listening.resolve(url);
        }
        if (said.first === "") {
          said.first = line;
        }
      },
    }, { cwd });
    child.closeInput();
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => { listening.reject(new OpencodeProviderAuthError("timed_out", `opencode serve did not start within ${String(timeoutMs)} ms`)); }, timeoutMs);
    void (async (): Promise<void> => {
      const exit = await child.exited;
      const words = said.first === "" ? "" : `: ${secrets.line(said.first)}`;
      listening.reject(new OpencodeProviderAuthError("startup_failed", `opencode serve exited (${exit.error ?? `code ${String(exit.exitCode)}`})${words}`));
    })();
    try {
      const url = await listening.promise;
      const running: Running = { process: child, url, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, exited: false };
      void (async (): Promise<void> => {
        await child.exited;
        running.exited = true;
      })();
      await this.#ready(running, deadline, pollMs);
      return running;
    } catch (error) {
      child.stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The registry fills in stages after listening; 2.2.7 lists its plugins only once it is complete. */
  async #ready(running: Running, deadline: number, pollMs: number): Promise<void> {
    for (;;) {
      const plugins = await this.#request(running, "GET", "/api/plugin");
      const integrations = await this.#request(running, "GET", "/api/integration");
      if (listed(plugins) && listed(integrations)) {
        return;
      }
      if (running.exited) {
        throw new OpencodeProviderAuthError("startup_failed", "opencode serve exited before its integrations loaded");
      }
      if (Date.now() + pollMs > deadline) {
        throw new OpencodeProviderAuthError("timed_out", "opencode serve did not load its integrations in time");
      }
      await new Promise((resolve) => { setTimeout(resolve, pollMs); });
    }
  }

  async #request(running: Running, method: HttpMethod, path: string, body?: unknown): Promise<ApiResponse> {
    try {
      const response = await fetch(`${running.url}${path}`, {
        method,
        headers: { authorization: running.authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
      const textBody = await response.text();
      return { status: response.status, body: textBody === "" ? undefined : parseJson(textBody) };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      // Never the request body: it may carry a key.
      throw new OpencodeProviderAuthError(timedOut ? "timed_out" : "server_failed", `${method} ${path} ${timedOut ? "timed out" : "failed: OpenCode's server did not answer"}`);
    }
  }
}
