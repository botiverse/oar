// BYOK change: Modified from OAR 95c6547 so the caller spawns, adopts and reaps every hosted terminal process (Apache-2.0).
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
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
// BYOK change: no cross-spawn and no executable manager; see SpawnAcpTerminal.

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const MAX_OUTPUT_LIMIT = 16 * 1024 * 1024;

interface ExitStatus {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

// BYOK change: one hosted command inside the caller's process-tree authority.
export interface AcpTerminalProcess {
  readonly child: ChildProcess;
  /** Settles once the caller owns the tree; rejects (with the process ended) when it cannot. */
  readonly spawned: Promise<void>;
  /** Ask the command and everything it started to stop; output stays readable. */
  terminate(): void;
  /** End the command's tree and resolve when it is gone. */
  dispose(): Promise<void>;
}

// BYOK change: the caller spawns with this exact environment and no ambient merge.
export type SpawnAcpTerminal = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly shell: boolean },
) => AcpTerminalProcess;

interface TerminalState {
  readonly process: AcpTerminalProcess; // BYOK change: caller-owned process.
  readonly child: ChildProcess;
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
  // a process it started (a shell's children). BYOK change: the caller's
  // disposal ends that whole tree, so the pipes close and the wait below ends.
  await state.process.dispose();
  await state.exited;
}

/** Host implementation of ACP v1's typed terminal reverse-RPC surface. */
export function createAcpTerminalHost(
  spawnTerminal: SpawnAcpTerminal, // BYOK change: caller-owned terminal processes.
  cwd: string,
  environment: Readonly<Record<string, string>>, // BYOK change: explicit environment.
  options: AcpTerminalHostOptions = {},
): OwnedAcpTerminalHost {
  const terminals = new Map<string, TerminalState>();
  // BYOK change: a released or disposed terminal stays here until its tree is
  // gone, so a later dispose (or its retry after a failed reap) still waits for it.
  const stopping = new Map<string, TerminalState>();
  let closing = false;
  let disposal: Promise<void> | undefined; // BYOK change: shared by every dispose caller.
  const stop = async (state: TerminalState): Promise<void> => {
    terminals.delete(state.terminalId);
    stopping.set(state.terminalId, state);
    await stopTerminal(state);
    stopping.delete(state.terminalId);
  };

  const create = async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
    if (params.command.length === 0) {
      invalid("ACP terminal request requires command");
    }
    if (params.cwd !== undefined && params.cwd !== null && !path.isAbsolute(params.cwd)) {
      invalid("ACP terminal cwd must be an absolute path");
    }
    if (closing) {
      // BYOK change: a command started after the reap began would escape it.
      throw RequestError.internalError(undefined, "ACP terminal host is disposed");
    }
    const terminalId = randomUUID();
    // BYOK change: the caller's spawn puts the command in its own owned tree
    // (a POSIX process group, a Windows job), so kill and release reach the
    // command and everything it started, not only the shell that launched it.
    // Upstream's OOM-score launch (#652) is omitted; see PROVENANCE.md.
    const owned = spawnTerminal(params.command, params.args ?? [], {
      cwd: params.cwd ?? cwd,
      env: {
        ...environment,
        ...Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value])),
      },
      shell: options.shellCommand === true && params.args === undefined,
    });
    const { child } = owned;
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) {
      await owned.dispose();
      throw RequestError.internalError(undefined, "ACP terminal process has no output streams");
    }
    const { promise: exited, resolve: resolveExited } = Promise.withResolvers<ExitStatus>();
    const state: TerminalState = {
      process: owned,
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
    child.once("close", (exitCode, signal) => {
      finish({ exitCode, signal });
    });
    child.once("error", () => {
      finish({ exitCode: null, signal: null });
    });
    try {
      await owned.spawned; // BYOK change: spawned and adopted by the caller.
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
      state.process.terminate(); // BYOK change: caller-owned tree termination.
    }
    return {};
  };

  const release = async (params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> => {
    const state = terminalFor(terminals, params);
    await stop(state); // BYOK change: tracked until the tree is gone.
    return {};
  };

  return {
    create,
    output,
    waitForExit,
    kill,
    release,
    // BYOK change: stopTerminal ends each command's tree through the caller's disposal.
    async end(terminalIds) {
      const running = [...new Set(terminalIds)].flatMap((id) => {
        const state = terminals.get(id);
        return state === undefined || state.exitStatus !== null ? [] : [state];
      });
      await Promise.all(running.map(async (state) => { await stopTerminal(state); }));
      return { signalled: running.length };
    },
    // BYOK change: one disposal for every concurrent caller. The exit observer
    // starts it unawaited; the session's own dispose waits for the same reap.
    // A failed reap is reported and a later call retries every tree still alive.
    dispose() {
      closing = true;
      disposal ??= Promise.all([...terminals.values(), ...stopping.values()].map(stop))
        .then(() => undefined, (error: unknown) => {
          disposal = undefined;
          throw error;
        });
      return disposal;
    },
  };
}
