/* oxlint-disable import/max-dependencies -- Experiment observes builtin process streams and reuses credential policy. */
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { asRecord as object, parseJson } from "../../packages/oar/src/shared/json.js";
import { sessionCredentialRedactor } from "../../packages/oar/src/shared/credential-redactor.js";

const STAGES = new Set(["initialize", "authenticate", "session/new", "session/load", "session/prompt"]);
const LINE_LIMIT = 1024 * 1024;
const TRACE_LIMIT = 64 * 1024;
type Context = () => Readonly<Record<string, string | null>>;
type RecordValue = Readonly<Record<string, unknown>>;

function isArgv(value: unknown): value is readonly string[] { return Array.isArray(value); }

function tap(target: { emit: NodeJS.EventEmitter["emit"] }, inspect: (event: string | symbol, values: unknown[]) => void): void {
  target.emit = new Proxy(target.emit, { apply(original, receiver: unknown, values: [string | symbol, ...unknown[]]): boolean {
    try { inspect(values[0], values.slice(1)); } catch { /* Observation never replaces dispatch. */ }
    return Reflect.apply(original, receiver, values);
  } });
}

/** Bounded framing for observation only. Original chunks are never replaced. */
function lines(receive: (line: string) => void, omitted: () => void, limit = LINE_LIMIT): { push(chunk: unknown): void; end(): void } {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  let partialBytes = 0;
  let dropping = false;
  return {
    push(chunk: unknown): void {
      if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk)) { return; }
      const text = typeof chunk === "string" ? chunk : decoder.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      for (const [index, piece] of text.split("\n").entries()) {
        if (index > 0) {
          if (!dropping) { receive(partial); }
          partial = "";
          partialBytes = 0;
          dropping = false;
        }
        if (!dropping) {
          const pieceBytes = Buffer.byteLength(piece);
          if (partialBytes + pieceBytes > limit) { partial = ""; partialBytes = 0; dropping = true; omitted(); }
          else { partial += piece; partialBytes += pieceBytes; }
        }
      }
    },
    end(): void {
      partial += decoder.end();
      if (!dropping && partial.length > 0) { receive(partial); }
      partial = "";
    },
  };
}

/** Recognize separate argv and cmd.exe's single escaped command string. Never execute the decoded text. */
function grokStdioArguments(argv: readonly string[]): "argv" | "cmd-string" | null {
  if (argv.includes("agent") && argv.includes("stdio")) { return "argv"; }
  const commandIndex = argv.findIndex((value, index) => value.toLowerCase() === "/c"
    && argv[index - 1]?.toLowerCase() === "/s" && argv[index - 2]?.toLowerCase() === "/d");
  const command = commandIndex === -1 ? undefined : argv[commandIndex + 1];
  const words = command?.replaceAll(/["^]/gu, "").split(/\s+/u) ?? [];
  return words.includes("agent") && words.includes("stdio") ? "cmd-string" : null;
}

function observeSpawn(context: Context, args: Parameters<typeof childProcess.spawn>, launch: () => ReturnType<typeof childProcess.spawn>): ReturnType<typeof childProcess.spawn> {
  const options: childProcess.SpawnOptions | undefined = isArgv(args[1]) ? args[2] : args[1];
  // The native overload also permits omitted options at runtime.
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- Proxy sees every spawn overload.
  const env = options?.env ?? process.env;
  const argv = isArgv(args[1]) ? args[1] : [];
  const directory = process.env.OAR_GROK_PROCESS_TRACE;
  const argumentForm = grokStdioArguments(argv);
  if (directory === undefined || directory === "" || env.GROK_HOME === undefined || env.GROK_HOME === "" || argumentForm === null) { return launch(); }
  const startedAt = Date.now();
  const started = performance.now();
  const id = `${process.pid}-${randomUUID()}`;
  const file = path.join(directory, `${id}.jsonl`);
  const stderrFile = path.join(directory, `${id}.stderr.json`);
  const redactor = sessionCredentialRedactor({ env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- Proxy sees every spawn overload.
  const privatePaths = [env.HOME, env.USERPROFILE, env.GROK_HOME, typeof options?.cwd === "string" ? options.cwd : undefined].filter((value): value is string => value !== undefined && value !== "").toSorted((a, b) => b.length - a.length);
  const stderr: string[] = [];
  let stderrBytes = 0;
  let stderrLines = 0;
  let bytes = 0;
  let capped = false;
  let disabled = false;
  let childPid: number | null = null;
  function safe(write: () => void): void {
    if (disabled) { return; }
    try { write(); } catch { disabled = true; process.stderr.write("[grok observation] diagnostic write failed\n"); }
  }
  const record = (phase: string, facts: RecordValue = {}, terminal = false): void => {
    if (disabled || (capped && !terminal)) { return; }
    safe(() => {
      let row = `${JSON.stringify({ at: Date.now(), elapsedMs: performance.now() - started, phase, childPid, ...facts })}\n`;
      if (!terminal && bytes + Buffer.byteLength(row) > TRACE_LIMIT) {
        capped = true;
        row = `${JSON.stringify({ at: Date.now(), phase: "trace_truncated", childPid, bytes })}\n`;
      }
      appendFileSync(file, row, { mode: 0o600 });
      bytes += Buffer.byteLength(row);
    });
  };
  safe(() => { mkdirSync(directory, { recursive: true }); });
  record("spawn_requested", { hostPid: process.pid, startedAt, argumentForm, ...context(),
    fixture: createHash("sha256").update(env.GROK_HOME).digest("hex").slice(0, 16) });
  const pending = new Map<string | number, { method: string; request: number }>();
  let request = 0;
  let firstFrame = true;
  let firstUpdate = true;
  let firstAgentOutput = true;
  const credentials = (value: unknown): void => {
    if (typeof value === "string") { redactor.add(value); }
    else if (Array.isArray(value)) { value.forEach(item => { credentials(item); }); }
    else if (object(value) !== null) { Object.values(object(value) ?? {}).forEach(item => { credentials(item); }); }
  };
  const incoming = (line: string): void => {
    const frame = object(parseJson(line));
    if (frame === null) { record("non_json_output"); return; }
    if (firstFrame) { firstFrame = false; record("first_protocol_frame"); }
    if (frame.method === "session/update" && firstUpdate) { firstUpdate = false; record("first_session_update"); }
    const update = object(object(frame.params)?.update)?.sessionUpdate;
    if (frame.method === "session/update" && firstAgentOutput && (update === "agent_message_chunk" || update === "agent_thought_chunk")) {
      firstAgentOutput = false;
      record("first_agent_output", { kind: update });
    }
    const key = frame.id;
    if ((typeof key === "string" || typeof key === "number") && frame.method === undefined) {
      const stage = pending.get(key);
      if (stage !== undefined) {
        pending.delete(key);
        const code = object(frame.error)?.code;
        record("response_received", { ...stage, outcome: frame.error === undefined ? "result" : "error", errorCode: typeof code === "number" ? code : null });
      }
    }
  };
  const outgoing = (line: string): void => {
    const frame = object(parseJson(line));
    if (frame === null || typeof frame.method !== "string" || !STAGES.has(frame.method)) { return; }
    if (frame.method === "authenticate") { credentials(frame.params); }
    if (frame.method === "session/new") { credentials(object(frame.params)?.mcpServers); }
    if ((typeof frame.id === "string" || typeof frame.id === "number") && pending.size < 64) {
      const stage = { method: frame.method, request: ++request };
      pending.set(frame.id, stage);
      record("request_sent", stage);
    }
  };
  const inputLines = lines(outgoing, () => { record("input_line_omitted"); });
  const outputLines = lines(incoming, () => { record("output_line_omitted"); });
  const redact = (text: string): string => {
    let clean = redactor.redact(text).replaceAll(/\bBearer\s+\S+/giu, "Bearer [redacted]")
      .replaceAll(/(?<prefix>(?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/giu, "$<prefix>[redacted]");
    for (const value of privatePaths) { clean = clean.replaceAll(value, "<fixture>"); }
    return clean;
  };
  const saveStderr = (): void => { safe(() => {
    writeFileSync(stderrFile, JSON.stringify({ at: Date.now(), childPid, bytes: stderrBytes, lines: stderrLines, tail: stderr.map(line => redact(line)), truncated: stderrLines > stderr.length }), { mode: 0o600 });
  }); };
  const stderrLinesReader = lines(line => {
    stderrLines += 1;
    // Redact before truncating, so a cutoff cannot expose half a credential.
    const clean = redact(line);
    stderr.push(clean.length > 512 ? "[long stderr line omitted]" : clean);
    if (stderr.length > 8) { stderr.shift(); }
  }, () => { stderrLines += 1; stderr.push("[oversized stderr line omitted]"); if (stderr.length > 8) { stderr.shift(); } }, 64 * 1024);
  const launchObserved = (): ReturnType<typeof childProcess.spawn> => {
    try { return launch(); } catch (error) {
      record("spawn_threw", { errorCode: typeof object(error)?.code === "string" ? object(error)?.code : null }, true);
      throw error;
    }
  };
  const child = launchObserved();
  childPid = child.pid ?? null;
  record("spawn_returned");
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let exited = false;
  const hostExit = (code: number): void => { record("host_exit_before_close", { hostExitCode: code, exited, exitCode, exitSignal }, true); };
  process.once("exit", hostExit);
  // Tap emit instead of adding data/error listeners: stream flow and unhandled
  // errors retain their original behavior. Every call keeps its return value.
  tap(child, (event, values) => {
    if (event === "spawn") { record("spawned"); }
    else if (event === "error") { record("process_error", { errorCode: typeof object(values[0])?.code === "string" ? object(values[0])?.code : null }, true); }
    else if (event === "exit") {
      exited = true;
      exitCode = typeof values[0] === "number" ? values[0] : null;
      exitSignal = typeof values[1] === "string" ? values[1] : null;
      record("exit", { exitCode, exitSignal, pending: [...pending.values()] }, true);
    } else if (event === "close") {
      stderrLinesReader.end(); saveStderr();
      record("close", { exitCode: values[0], exitSignal: values[1], pending: [...pending.values()] }, true);
      process.off("exit", hostExit);
    }
  });
  let firstOutput = true;
  if (child.stdout !== null) { tap(child.stdout, (event, values) => {
    if (event === "data") { if (firstOutput) { firstOutput = false; record("first_stdout"); } outputLines.push(values[0]); }
  }); }
  if (child.stderr !== null) { tap(child.stderr, (event, values) => {
    if (event === "data") {
      const [chunk] = values;
      if (typeof chunk === "string") { stderrBytes += Buffer.byteLength(chunk); }
      else if (ArrayBuffer.isView(chunk)) { stderrBytes += chunk.byteLength; }
      stderrLinesReader.push(chunk);
      saveStderr();
    } else if (event === "end") { stderrLinesReader.end(); saveStderr(); }
  }); }
  if (child.stdin !== null) {
    // oxlint-disable-next-line typescript/unbound-method -- Proxy applies the original receiver unchanged.
    child.stdin.write = new Proxy(child.stdin.write, { apply(original, receiver: unknown, values: Parameters<typeof child.stdin.write>): boolean {
      const accepted = Reflect.apply(original, receiver, values);
      try { inputLines.push(values[0]); } catch { /* Keep the original write result. */ }
      return accepted;
    } });
  }
  return child;
}

/** Install in the test host only; never preload or wrap the vendor executable. */
export function observeGrokProcesses(context: Context = () => ({})): () => void {
  const { spawn } = childProcess;
  const observed = new Proxy(spawn, {
    apply(target, receiver: unknown, args: Parameters<typeof spawn>): ReturnType<typeof spawn> {
      return observeSpawn(context, args, () => Reflect.apply(target, receiver, args));
    },
  });
  childProcess.spawn = observed;
  syncBuiltinESMExports();
  return () => { if (childProcess.spawn === observed) { childProcess.spawn = spawn; syncBuiltinESMExports(); } };
}
