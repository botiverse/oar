import { PassThrough, Writable } from "node:stream";
import type { LineProcess } from "../../shared/executable/index.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { qoderDaemonAuth } from "./protocol.js";
import { qoderControl, qoderInitializeTimeoutMs } from "./control.js";

/** The official SDK's daemon transport, owned by exactly one OAR session. */
export async function qoderDaemonSession(child: LineProcess, sessionId: string, workerArgs: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<LineProcess> {
  const controls = qoderControl(child, () => {}, qoderInitializeTimeoutMs);
  const handlers: ((line: string) => void)[] = [];
  const buffered: string[] = [];
  const failure: { error?: Error } = {};
  const stdout = new PassThrough();
  stdout.resume();
  let ready = false;
  child.onLine((line) => {
    const frame = asRecord(parseJson(line));
    if (frame === null || failure.error !== undefined) { return; }
    if (frame.session_id !== undefined && frame.session_id !== sessionId) {
      failure.error = new Error("Qoder daemon received a frame belonging to another session; OAR terminated the owned process");
      controls.end(); child.kill(); return;
    }
    if (controls.consume(frame) || frame.type === "keep_alive") { return; }
    // Connection-wide notifications may be added by newer native daemons.
    // Preserve unfamiliar frames without an id instead of guessing their meaning.
    if (!ready) { buffered.push(line); return; }
    stdout.write(`${line}\n`);
    for (const handler of handlers) { handler(line); }
  });
  child.onExit(() => { controls.end(); stdout.end(); });
  const write = (text: string): void => {
    if (failure.error !== undefined) { throw failure.error; }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) { continue; }
      const frame = asRecord(parseJson(line));
      if (frame === null || (frame.session_id !== undefined && frame.session_id !== sessionId)) {
        throw new Error("Qoder daemon input does not belong to this session");
      }
      const request = asRecord(frame.request);
      if (frame.type === "control_request" && request?.subtype === "get_models" && typeof frame.request_id === "string") {
        // The official daemon query plane moved account-level controls out of
        // sessions. Its reply has the identical payload and no session_id.
        const { subtype: _subtype, ...params } = request;
        child.write(`${JSON.stringify({ type: frame.type, request_id: frame.request_id, request: { ...params, type: "daemon.get_models" } })}\n`);
      } else { child.write(`${JSON.stringify({ ...frame, session_id: sessionId })}\n`); }
    }
  };
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback): void { try { write(chunk.toString()); callback(); } catch (error) { callback(error instanceof Error ? error : new Error(String(error))); } },
    final(callback): void {
      // EOF on the dedicated daemon is its native shutdown boundary. The
      // caller retains the same bounded process-tree cleanup as the worker.
      child.stdin.end(); callback();
    },
  });
  stdin.on("error", () => { child.kill(); });
  try {
    const initialized = await controls.request({ type: "daemon.initialize", daemon_protocol_version: 2,
      sdk_version: "oar", capabilities: ["multi_session_v2", "daemon_queries_v1"], auth: qoderDaemonAuth(env) });
    const result = asRecord(asRecord(initialized.response)?.response);
    const capabilities = result?.capabilities;
    if (result?.daemon_protocol_version !== 2 || !Array.isArray(capabilities) || !["multi_session_v2", "daemon_queries_v1"].every((capability) => capabilities.includes(capability))) {
      throw new Error("Qoder daemon did not confirm protocol version 2 and session routing");
    }
    const opened = await controls.request({ type: "daemon.open_session", worker_args: workerArgs, cwd });
    if (opened.session_id !== sessionId) { throw new Error("Qoder daemon did not confirm the requested session identity"); }
    return {
      spawned: child.spawned, exited: child.exited, stdin, stdout, write,
      diagnostics: () => ({ ...child.diagnostics(), ...(failure.error === undefined ? {} : {
        error: { code: "QODER_PROTOCOL_ERROR", message: failure.error.message },
      }) }), resources: child.resources,
      kill: () => { child.kill(); }, onExit: (handler) => { child.onExit(handler); },
      onLine(handler) {
        handlers.push(handler);
        if (ready) { return; }
        ready = true;
        for (const line of buffered.splice(0)) { stdout.write(`${line}\n`); handler(line); }
      },
    };
  } catch (error) { controls.end(); child.kill(); await child.exited; throw failure.error ?? error; }
}
