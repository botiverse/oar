/* oxlint-disable typescript/promise-function-async -- SDK handlers deliberately return terminal promises directly. */
import {
  client as createClient,
  methods,
  RequestError,
  type ClientApp,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import spawn from "cross-spawn";

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const MAX_OUTPUT_LIMIT = 16 * 1024 * 1024;

interface ExitStatus {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

interface TerminalState {
  readonly child: ReturnType<typeof spawn>;
  readonly exited: Promise<ExitStatus>;
  readonly sessionId: string;
  readonly stderrDecoder: StringDecoder;
  readonly stdoutDecoder: StringDecoder;
  readonly terminalId: string;
  readonly outputLimit: number;
  exitStatus: ExitStatus | null;
  output: string;
  truncated: boolean;
}

export interface AcpTerminalHost {
  create(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
  output(params: TerminalOutputRequest): TerminalOutputResponse;
  waitForExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse>;
  kill(params: KillTerminalRequest): KillTerminalResponse;
  release(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse>;
  dispose(): Promise<void>;
}

export interface AcpTerminalHostOptions {
  readonly shellCommand?: boolean;
}

function allowPermission(request: RequestPermissionRequest): RequestPermissionResponse {
  const selected = request.options.find((option) => option.kind === "allow_always")
    ?? request.options.find((option) => option.kind === "allow_once");
  return selected === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: selected.optionId } };
}

/** Compose OAR's typed ACP client handlers directly on the official SDK app. */
export function createAcpClientApp(
  terminal: AcpTerminalHost,
  update: (notification: SessionNotification) => void,
): ClientApp {
  return createClient({ name: "oar" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => allowPermission(params))
    .onRequest(methods.client.terminal.create, ({ params }) => terminal.create(params))
    .onRequest(methods.client.terminal.output, ({ params }) => terminal.output(params))
    .onRequest(methods.client.terminal.waitForExit, ({ params }) => terminal.waitForExit(params))
    .onRequest(methods.client.terminal.kill, ({ params }) => terminal.kill(params))
    .onRequest(methods.client.terminal.release, ({ params }) => terminal.release(params))
    .onNotification(methods.client.session.update, ({ params }) => {
      update(params);
    });
}

function invalid(message: string): never {
  throw RequestError.invalidParams(undefined, message);
}

function outputLimit(value: number | null | undefined): number {
  if (value === undefined || value === null) {
    return DEFAULT_OUTPUT_LIMIT;
  }
  if (!Number.isFinite(value) || value < 0) {
    invalid("ACP terminal outputByteLimit must be finite and nonnegative");
  }
  return Math.min(Math.floor(value), MAX_OUTPUT_LIMIT);
}

function tailAtCharacterBoundary(value: string, limit: number): string {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= limit) {
    return value;
  }
  let start = encoded.byteLength - limit;
  while (start < encoded.byteLength) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0xC0) !== 0x80) {
      break;
    }
    start += 1;
  }
  return encoded.subarray(start).toString("utf8");
}

function appendOutput(state: TerminalState, text: string): void {
  if (text.length === 0) {
    return;
  }
  const combined = `${state.output}${text}`;
  if (Buffer.byteLength(combined) > state.outputLimit) {
    state.truncated = true;
    state.output = tailAtCharacterBoundary(combined, state.outputLimit);
  } else {
    state.output = combined;
  }
}

function terminalFor(
  terminals: ReadonlyMap<string, TerminalState>,
  params: TerminalOutputRequest,
): TerminalState {
  const terminal = terminals.get(params.terminalId);
  if (terminal === undefined || terminal.sessionId !== params.sessionId) {
    invalid(`Unknown ACP terminal: ${params.terminalId}`);
  }
  return terminal;
}

async function stopTerminal(state: TerminalState): Promise<void> {
  if (state.exitStatus === null) {
    state.child.kill("SIGKILL");
  }
  await state.exited;
}

/** Host implementation of ACP v1's typed terminal reverse-RPC surface. */
export function createAcpTerminalHost(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: AcpTerminalHostOptions = {},
): AcpTerminalHost {
  const terminals = new Map<string, TerminalState>();

  const create = async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
    if (params.command.length === 0) {
      invalid("ACP terminal request requires command");
    }
    if (params.cwd !== undefined && params.cwd !== null && !path.isAbsolute(params.cwd)) {
      invalid("ACP terminal cwd must be an absolute path");
    }
    const terminalId = randomUUID();
    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? cwd,
      env: {
        ...environment,
        ...Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value])),
      },
      shell: options.shellCommand === true && params.args === undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) {
      child.kill("SIGKILL");
      throw RequestError.internalError(undefined, "ACP terminal process has no output streams");
    }
    const { promise: spawned, resolve: resolveSpawned, reject: rejectSpawned } =
      Promise.withResolvers<void>();
    const { promise: exited, resolve: resolveExited } = Promise.withResolvers<ExitStatus>();
    const state: TerminalState = {
      child,
      exited,
      sessionId: params.sessionId,
      stderrDecoder: new StringDecoder("utf8"),
      stdoutDecoder: new StringDecoder("utf8"),
      terminalId,
      outputLimit: outputLimit(params.outputByteLimit),
      exitStatus: null,
      output: "",
      truncated: false,
    };
    terminals.set(terminalId, state);
    stdout.on("data", (chunk: Buffer | string) => {
      appendOutput(state, state.stdoutDecoder.write(Buffer.from(chunk)));
    });
    stderr.on("data", (chunk: Buffer | string) => {
      appendOutput(state, state.stderrDecoder.write(Buffer.from(chunk)));
    });
    const finish = (status: ExitStatus): void => {
      if (state.exitStatus !== null) {
        return;
      }
      appendOutput(state, state.stdoutDecoder.end());
      appendOutput(state, state.stderrDecoder.end());
      state.exitStatus = status;
      resolveExited(status);
    };
    child.once("spawn", resolveSpawned);
    child.once("close", (exitCode, signal) => {
      finish({ exitCode, signal });
    });
    child.once("error", (error) => {
      rejectSpawned(error);
      finish({ exitCode: null, signal: null });
    });
    try {
      await spawned;
    } catch (error) {
      terminals.delete(terminalId);
      throw RequestError.internalError(
        undefined,
        error instanceof Error ? error.message : "Failed to create ACP terminal",
      );
    }
    return { terminalId };
  };

  const output = (params: TerminalOutputRequest): TerminalOutputResponse => {
    const state = terminalFor(terminals, params);
    return {
      output: state.output,
      truncated: state.truncated,
      ...(state.exitStatus === null ? {} : { exitStatus: state.exitStatus }),
    };
  };

  const waitForExit = async (
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> => ({
    ...await terminalFor(terminals, params).exited,
  });

  const kill = (params: KillTerminalRequest): KillTerminalResponse => {
    const state = terminalFor(terminals, params);
    if (state.exitStatus === null) {
      state.child.kill("SIGTERM");
    }
    return {};
  };

  const release = async (params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> => {
    const state = terminalFor(terminals, params);
    terminals.delete(state.terminalId);
    await stopTerminal(state);
    return {};
  };

  return {
    create,
    output,
    waitForExit,
    kill,
    release,
    async dispose() {
      const active = [...terminals.values()];
      terminals.clear();
      await Promise.all(active.map(async (state) => {
        await stopTerminal(state);
      }));
    },
  };
}
