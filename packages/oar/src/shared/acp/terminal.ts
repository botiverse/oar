import { methods } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import spawn from "cross-spawn";
import { asNumber, asRecord, type JsonRecord } from "../json.js";
import { acpRpcError } from "./errors.js";

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
  readonly enabled: true;
  handles(method: string): boolean;
  request(method: string, params: JsonRecord): Promise<JsonRecord>;
  dispose(): Promise<void>;
}

export interface AcpTerminalHostOptions {
  readonly shellCommand?: boolean;
}

function invalid(message: string): never {
  throw acpRpcError(-32_602, message);
}

function requiredString(params: JsonRecord, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    invalid(`ACP terminal request requires ${name}`);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    invalid("ACP terminal args must be strings");
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      invalid("ACP terminal args must be strings");
    }
    return item;
  });
}

function requestedEnvironment(value: unknown): NodeJS.ProcessEnv {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value)) {
    invalid("ACP terminal env must be an array");
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const item of value) {
    const variable = asRecord(item);
    if (typeof variable?.name !== "string" || typeof variable.value !== "string") {
      invalid("ACP terminal env entries require string name and value");
    }
    environment[variable.name] = variable.value;
  }
  return environment;
}

function outputLimit(value: unknown): number {
  const requested = asNumber(value);
  if (requested === null) {
    return DEFAULT_OUTPUT_LIMIT;
  }
  if (requested < 0) {
    invalid("ACP terminal outputByteLimit cannot be negative");
  }
  return Math.min(Math.floor(requested), MAX_OUTPUT_LIMIT);
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
  params: JsonRecord,
): TerminalState {
  const terminalId = requiredString(params, "terminalId");
  const sessionId = requiredString(params, "sessionId");
  const terminal = terminals.get(terminalId);
  if (terminal === undefined || terminal.sessionId !== sessionId) {
    invalid(`Unknown ACP terminal: ${terminalId}`);
  }
  return terminal;
}

async function stopTerminal(state: TerminalState): Promise<void> {
  if (state.exitStatus === null) {
    state.child.kill("SIGKILL");
  }
  await state.exited;
}

/** Host implementation of ACP v1's terminal reverse-RPC surface. */
export function createAcpTerminalHost(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: AcpTerminalHostOptions = {},
): AcpTerminalHost {
  const terminals = new Map<string, TerminalState>();

  const create = async (params: JsonRecord): Promise<JsonRecord> => {
    const sessionId = requiredString(params, "sessionId");
    const command = requiredString(params, "command");
    const requestedCwd = params.cwd;
    if (requestedCwd !== undefined && (typeof requestedCwd !== "string" || !path.isAbsolute(requestedCwd))) {
      invalid("ACP terminal cwd must be an absolute path");
    }
    const terminalId = randomUUID();
    const child = spawn(command, stringArray(params.args), {
      cwd: requestedCwd ?? cwd,
      env: { ...environment, ...requestedEnvironment(params.env) },
      shell: options.shellCommand === true && params.args === undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) {
      child.kill("SIGKILL");
      throw acpRpcError(-32_603, "ACP terminal process has no output streams");
    }
    const { promise: spawned, resolve: resolveSpawned, reject: rejectSpawned } =
      Promise.withResolvers<void>();
    const { promise: exited, resolve: resolveExited } = Promise.withResolvers<ExitStatus>();
    const state: TerminalState = {
      child,
      exited,
      sessionId,
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
      throw acpRpcError(
        -32_603,
        error instanceof Error ? error.message : "Failed to create ACP terminal",
      );
    }
    return { terminalId };
  };

  const output = (params: JsonRecord): JsonRecord => {
    const state = terminalFor(terminals, params);
    return {
      output: state.output,
      truncated: state.truncated,
      ...(state.exitStatus === null ? {} : { exitStatus: state.exitStatus }),
    };
  };

  const waitForExit = async (params: JsonRecord): Promise<JsonRecord> => ({
    ...await terminalFor(terminals, params).exited,
  });

  const kill = (params: JsonRecord): JsonRecord => {
    const state = terminalFor(terminals, params);
    if (state.exitStatus === null) {
      state.child.kill("SIGTERM");
    }
    return {};
  };

  const release = async (params: JsonRecord): Promise<JsonRecord> => {
    const state = terminalFor(terminals, params);
    terminals.delete(state.terminalId);
    await stopTerminal(state);
    return {};
  };

  return {
    enabled: true,
    handles: (method) => method.startsWith("terminal/"),
    async request(method, params) {
      switch (method) {
        case methods.client.terminal.create: {
          const result = await create(params);
          return result;
        }
        case methods.client.terminal.output:
          return output(params);
        case methods.client.terminal.waitForExit: {
          const result = await waitForExit(params);
          return result;
        }
        case methods.client.terminal.kill:
          return kill(params);
        case methods.client.terminal.release: {
          const result = await release(params);
          return result;
        }
        default:
          throw acpRpcError(-32_601, `ACP client method not found: ${method}`);
      }
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
