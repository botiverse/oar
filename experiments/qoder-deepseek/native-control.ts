import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

type NativeReply = Record<string, unknown>;
interface NativeExit { code: number | null; signal: NodeJS.Signals | null }
interface NativeControl {
  request(type: string, fields?: NativeReply): Promise<NativeReply>;
  initialize(): Promise<NativeReply>;
  close(): Promise<NativeExit>;
}
export class NativeFailureError extends Error {
  constructor(readonly code: string) { super(code); this.name = "NativeFailureError"; }
}

/** Control replies may contain credentials; only the caller's selected facts are retained. */
export function nativeControl(command: string): NativeControl {
  const environment: NodeJS.ProcessEnv = { ...process.env, QODER_AGENT_SDK_DAEMON: "1", NO_BROWSER: "1" };
  delete environment.DEEPSEEK_API_KEY;
  const child = spawn(command, ["--sdk"], {
    env: environment, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  const pending = new Map<string, PromiseWithResolvers<NativeReply> & { timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0;
  let exited = false;
  const exit = Promise.withResolvers<NativeExit>();
  child.once("close", (code, signal) => {
    exited = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new NativeFailureError("PROCESS_EXITED")); }
    pending.clear(); exit.resolve({ code, signal });
  });
  child.stderr.on("data", () => {});
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = asRecord(parseJson(line));
    if (frame?.type !== "control_response") { return; }
    const response = asRecord(frame.response);
    if (response === null || typeof response.request_id !== "string") { return; }
    const item = pending.get(response.request_id);
    if (item === undefined) { return; }
    pending.delete(response.request_id); clearTimeout(item.timer);
    if (response.subtype === "success") { item.resolve(asRecord(response.response) ?? {}); }
    else {
      const code = response.code ?? asRecord(response.error)?.code;
      item.reject(new NativeFailureError(typeof code === "string" ? code : "NATIVE_CONTROL_REFUSED"));
    }
  });
  const fail = (): void => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new NativeFailureError("SPAWN_FAILED")); }
    pending.clear();
  };
  child.on("error", fail); child.stdin.on("error", fail);
  async function request(type: string, fields: NativeReply = {}): Promise<NativeReply> {
    const requestId = `oar-byok-${++sequence}`;
    const result = Promise.withResolvers<NativeReply>();
    const timer = setTimeout(() => { pending.delete(requestId); result.reject(new NativeFailureError("CONTROL_TIMEOUT")); }, 30_000);
    pending.set(requestId, { ...result, timer });
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { type, ...fields } })}\n`);
    const reply = await result.promise;
    return reply;
  }
  function stop(signal: NodeJS.Signals): void {
    if (exited || child.pid === undefined) { return; }
    try {
      if (process.platform === "win32") { child.kill(signal); } else { process.kill(-child.pid, signal); }
    } catch { /* Already exited. */ }
  }
  return {
    request,
    async initialize(): Promise<NativeReply> {
      const reply = await request("daemon.initialize", { daemon_protocol_version: 2, sdk_version: "oar",
        capabilities: ["multi_session_v2", "daemon_queries_v1"], auth: { type: "qodercli" } });
      return reply;
    },
    async close(): Promise<NativeExit> {
      child.stdin.end();
      const term = setTimeout(() => { stop("SIGTERM"); }, 3000);
      const kill = setTimeout(() => { stop("SIGKILL"); }, 5000);
      try { return await exit.promise; } finally { clearTimeout(term); clearTimeout(kill); }
    },
  };
}
