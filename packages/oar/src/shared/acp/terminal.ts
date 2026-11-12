/* oxlint-disable typescript/promise-function-async -- SDK handlers deliberately return terminal promises directly. */
import {
  RequestError,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import { terminalLaunch } from "./terminal-launch.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import spawn from "cross-spawn";
import { spawnChecked, killProcessTree, OWN_PROCESS_GROUP, signalProcessGroup, trackOwnedProcess } from "../executable/index.js";

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

/** The host a session owns: the runtime's terminal surface, plus ending chosen terminals. */
export interface OwnedAcpTerminalHost extends AcpTerminalHost {
  /**
   * Stop these terminals' commands (their process groups; their trees on
   * Windows) if still running, keeping the terminals so the runtime can still
   * read and release them. Counts the commands it had to stop.
   */
  end(terminalIds: readonly string[]): Promise<{ readonly signalled: number }>;
}

export interface AcpTerminalHostOptions {
  readonly shellCommand?: boolean;
  /** Native process issuing reverse terminal requests. */
  readonly agentPid?: () => number | undefined;
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
  // Until `close`, something may still hold the output pipes: the command or
  // a process it started (a shell's children). Killing the group reaches
  // them all, so the pipes close and the wait below ends.
  if (state.exitStatus === null) {
    if (process.platform === "win32") {
      killProcessTree(state.child);
    } else {
      signalProcessGroup(state.child, "SIGKILL");
    }
  }
  await state.exited;
}

/** Host implementation of ACP v1's typed terminal reverse-RPC surface. */
export function createAcpTerminalHost(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: AcpTerminalHostOptions = {},
): OwnedAcpTerminalHost {
  const terminals = new Map<string, TerminalState>();

  const create = async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
    if (params.command.length === 0) {
      invalid("ACP terminal request requires command");
    }
    if (params.cwd !== undefined && params.cwd !== null && !path.isAbsolute(params.cwd)) {
      invalid("ACP terminal cwd must be an absolute path");
    }
    const terminalId = randomUUID();
    const commandCwd = params.cwd ?? cwd;
    const env = { ...environment, ...Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value])) };
    const launch = terminalLaunch(params.command, params.args ?? [], commandCwd, env,
      options.shellCommand === true && params.args === undefined, options.agentPid?.());
    const child = spawnChecked(() => spawn(launch.command, launch.args, {
      cwd: commandCwd,
      env,
      shell: launch.shell,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group (POSIX): kill and release reach the command and
      // everything it started, not only the shell that launched it.
      detached: OWN_PROCESS_GROUP,
    }));
    trackOwnedProcess(child);
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
      if (process.platform === "win32") {
        killProcessTree(state.child);
      } else {
        signalProcessGroup(state.child, "SIGTERM");
      }
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
    async end(terminalIds) {
      const running = [...new Set(terminalIds)].flatMap((id) => {
        const state = terminals.get(id);
        return state === undefined || state.exitStatus !== null ? [] : [state];
      });
      await Promise.all(running.map(async (state) => { await stopTerminal(state); }));
      return { signalled: running.length };
    },
    async dispose() {
      const active = [...terminals.values()];
      terminals.clear();
      await Promise.all(active.map(async (state) => {
        await stopTerminal(state);
      }));
    },
  };
}
