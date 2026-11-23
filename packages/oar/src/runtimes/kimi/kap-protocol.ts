import type { McpServer } from "../../contracts/session.js";
import { requestFailure } from "../../shared/credential-http.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { appendStartupStderr } from "../../shared/executable/reported-stderr.js";
import type { LoadedImage } from "../../shared/input-images.js";
import { asNumber, asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { checkManagedLaunchArgs } from "../../shared/launch-args.js";
import { checkMcpServerNames, isHttpMcpServer } from "../../shared/mcp-servers.js";

/** Flags owned by OAR when launching `kimi web --json`; collides with `--json`, bind/port, or remote-control options. */
export const KIMI_KAP_MANAGED_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "--host",
  "--port",
  "--open",
  "--no-open",
  "--socket",
  "--remote-control",
  "--rc",
  "--dangerous-bypass-auth",
  "--allow-remote-shutdown",
  "--debug-endpoints",
  "--managed-by",
]);

export function checkKimiKapLaunchArgs(args: readonly string[] | undefined): void {
  checkManagedLaunchArgs(args, KIMI_KAP_MANAGED_FLAGS, (flag) => `Kimi manages ${flag} itself when opening a KAP session`);
}

export interface KapBootInfo {
  readonly origin: string;
  readonly wsUrl: string;
  readonly token: string;
  readonly protocolVersion: string;
}

export class KapApiError extends Error {
  readonly code: number;
  readonly msg: string;
  readonly httpStatus: number;
  readonly envelope: JsonRecord;

  constructor(code: number, msg: string, httpStatus: number, envelope: JsonRecord) {
    super(msg);
    this.name = "KapApiError";
    this.code = code;
    this.msg = msg;
    this.httpStatus = httpStatus;
    this.envelope = envelope;
  }
}

export const REQUIRED_KAP_CAPABILITIES = [
  "websocket",
  "tasks",
  "session_ephemeral_mcp",
  "session_append_system_prompt",
  "steer_parent_correlation",
] as const;

export function hasRequiredKapCapabilities(meta: JsonRecord): boolean {
  const capabilities = asRecord(meta.capabilities);
  if (capabilities === null) { return false; }
  return REQUIRED_KAP_CAPABILITIES.every((key) => capabilities[key] === true);
}

function parseBootLine(line: string): KapBootInfo | null {
  const record = asRecord(parseJson(line));
  if (record === null) { return null; }
  const { origin, ws_url: wsUrl, token, kimi_agent_protocol_version: protocolVersion } = record;
  if (typeof origin !== "string" || typeof wsUrl !== "string" || typeof token !== "string" || typeof protocolVersion !== "string") {
    return null;
  }
  if (token.length === 0 || protocolVersion.length === 0) { return null; }
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) || !/^ws:\/\/127\.0\.0\.1:\d+\/api\/v1\/ws$/u.test(wsUrl)) {
    return null;
  }
  return { origin, wsUrl, token, protocolVersion };
}

function isUnsupportedJsonFlag(stderr: string): boolean {
  return /unknown option[^]*--json|unrecognized option[^]*--json|unexpected argument[^]*--json|unknown flag[^]*--json/iu.test(stderr);
}

export type KapProcessStart =
  | { readonly kind: "ready"; readonly child: LineProcess; readonly boot: KapBootInfo }
  | { readonly kind: "fallback_acp" };

/**
 * Launch `kimi web --json --host 127.0.0.1 --port 0` and register the ephemeral
 * bearer immediately on receipt of the ready JSON line.
 */
export async function startKimiKapProcess(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  launchArgs: readonly string[] | undefined,
  onToken: (token: string) => void,
  redact: (text: string) => string,
  timeoutMs = 30_000,
): Promise<KapProcessStart> {
  checkKimiKapLaunchArgs(launchArgs);
  const args = ["web", "--json", "--host", "127.0.0.1", "--port", "0", ...(launchArgs ?? [])];
  const child = spawnLineProcess(command, args, { cwd, env, killTree: true, inheritStderr: false });
  const result = Promise.withResolvers<KapProcessStart>();
  // Observe readiness rejection if spawning or early exit settles before `await result.promise`.
  void (async (): Promise<void> => { try { await result.promise; } catch { /* Caller observes spawn or readiness error. */ } })();
  let settled = false;
  const finishOk = (value: KapProcessStart): void => {
    if (settled) { return; }
    settled = true;
    clearTimeout(timer);
    result.resolve(value);
  };
  const finishErr = (error: unknown): void => {
    if (settled) { return; }
    settled = true;
    clearTimeout(timer);
    result.reject(error instanceof Error ? error : new Error(String(error)));
  };
  const timer = setTimeout(() => {
    const err = new Error(`Kimi KAP server did not become ready within ${String(timeoutMs)} ms`);
    finishErr(appendStartupStderr(err, child.diagnostics(), redact));
  }, timeoutMs);
  timer.unref();
  child.onLine((line) => {
    const boot = parseBootLine(line);
    if (boot === null) { return; }
    onToken(boot.token);
    finishOk({ kind: "ready", child, boot });
  });
  child.onExit((code, reason) => {
    if (settled) { return; }
    const diagnostics = child.diagnostics();
    if (isUnsupportedJsonFlag(diagnostics.stderr)) {
      finishOk({ kind: "fallback_acp" });
      return;
    }
    const detail = reason ?? (code === null ? "signal" : `code ${String(code)}`);
    finishErr(appendStartupStderr(new Error(`Kimi KAP server exited before readiness (${detail})`), diagnostics, redact));
  });
  try {
    await child.spawned;
    const outcome = await result.promise;
    if (outcome.kind === "fallback_acp") {
      await child.exited;
    }
    return outcome;
  } catch (error) {
    settled = true;
    clearTimeout(timer);
    child.kill();
    await child.exited;
    throw error;
  }
}

export async function kapRequest(
  origin: string,
  token: string,
  path: string,
  options: {
    readonly method?: "GET" | "POST" | "DELETE" | "PATCH";
    readonly body?: JsonRecord;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<JsonRecord> {
  const timeoutSignal = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal !== undefined && timeoutSignal !== undefined
    ? AbortSignal.any([options.signal, timeoutSignal])
    : (options.signal ?? timeoutSignal);
  const response = await fetch(`${origin}/api/v1${path}`, {
    method: options.method ?? "GET",
    redirect: "error",
    ...(signal === undefined ? {} : { signal }),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }).catch((error: unknown) => {
    throw requestFailure("Kimi KAP request failed", error);
  });
  let rawText = "";
  try {
    rawText = await response.text();
  } catch (error) {
    throw requestFailure("Kimi KAP response read failed", error);
  }
  const envelope = asRecord(parseJson(rawText));
  if (envelope === null) {
    throw new Error(`Kimi KAP HTTP ${String(response.status)} returned non-JSON body`);
  }
  const code = asNumber(envelope.code);
  const msg = typeof envelope.msg === "string" && envelope.msg.length > 0
    ? envelope.msg
    : `Kimi KAP request failed (HTTP ${String(response.status)})`;
  if (code !== null && code !== 0) {
    throw new KapApiError(code, msg, response.status, envelope);
  }
  if (!response.ok || code === null) {
    throw new KapApiError(code ?? response.status, msg, response.status, envelope);
  }
  return asRecord(envelope.data) ?? {};
}

export function checkKimiKapMcpServers(servers: readonly McpServer[] | undefined): void {
  if (servers !== undefined) {
    checkMcpServerNames(servers);
  }
}

/** Convert OAR `McpServer[]` to KAP's `{ [name]: McpServerConfigWire }` map, avoiding prototype mutation. */
export function toKapMcpServers(servers: readonly McpServer[]): JsonRecord {
  checkMcpServerNames(servers);
  const map: JsonRecord = {};
  for (const server of servers) {
    const entry: JsonRecord = isHttpMcpServer(server)
      ? {
          transport: "http",
          url: server.url,
          ...(server.headers !== undefined && Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
        }
      : {
          transport: "stdio",
          command: server.command,
          ...(server.args !== undefined && server.args.length > 0 ? { args: [...server.args] } : {}),
          ...(server.env !== undefined && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
        };
    Object.defineProperty(map, server.name, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return map;
}

/** Build KAP `content` parts: base64 image blocks before text, omitting an empty text block when images exist. */
export function buildKapContent(text: string, images: readonly LoadedImage[]): JsonRecord[] {
  const parts: JsonRecord[] = images.map((image) => ({
    type: "image",
    source: { kind: "base64", media_type: image.mediaType, data: image.data },
  }));
  if (text.length > 0 || images.length === 0) {
    parts.push({ type: "text", text });
  }
  return parts;
}
