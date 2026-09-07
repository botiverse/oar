import spawn from "cross-spawn";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** A long-lived child whose raw streams can also be observed line-by-line. */
export interface LineProcess {
  /** Resolves once the OS process exists; rejects when it cannot be spawned. */
  readonly spawned: Promise<void>;
  /** Resolves when the process is truly gone and its state has been released. */
  readonly exited: Promise<number | null>;
  readonly stdin: Writable;
  readonly stdout: Readable;
  write(text: string): void;
  /** Complete UTF-8 lines, independent of stdout byte-chunk boundaries. */
  onLine(handler: (line: string) => void): void;
  /** Fires exactly once, for exit or spawn-level error alike. */
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

/** Windows npm shims need a shell for one-shot execFile calls. */
export function requiresShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/iu.test(command);
}

/**
 * Spawn through cross-spawn so Windows .cmd shims preserve multi-word args.
 * Line parsing is attached lazily; protocol SDKs can consume the raw streams.
 */
export function spawnLineProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): LineProcess {
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", process.env.OAR_CHILD_STDERR === "inherit" ? "inherit" : "ignore"],
  });
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) {
    throw new Error("line process stdio must be piped");
  }
  const lineHandlers: ((line: string) => void)[] = [];
  const exitHandlers: ((code: number | null) => void)[] = [];
  let buffer = "";
  let readingLines = false;
  let ended = false;
  let exitCode: number | null = null;
  const { promise: spawned, resolve: spawnOk, reject: spawnFailed } = Promise.withResolvers<void>();
  const { promise: exited, resolve: exitDone } = Promise.withResolvers<number | null>();
  child.once("spawn", spawnOk);
  const end = (code: number | null): void => {
    if (ended) {
      return;
    }
    ended = true;
    exitCode = code;
    for (const handler of exitHandlers) {
      handler(code);
    }
    exitDone(code);
  };
  child.on("exit", end);
  child.on("error", (error) => {
    spawnFailed(error);
    end(null);
  });

  const readLines = (): void => {
    // Keep incomplete UTF-8 code points between chunks without changing the
    // raw stdout stream used by protocol SDKs and other observers.
    const decoder = new StringDecoder("utf8");
    stdout.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (line.length > 0) {
          for (const handler of lineHandlers) {
            handler(line);
          }
        }
      }
    });
  };

  return {
    spawned,
    exited,
    stdin,
    stdout,
    write: (text) => {
      stdin.write(text);
    },
    onLine(handler) {
      lineHandlers.push(handler);
      if (!readingLines) {
        readingLines = true;
        readLines();
      }
    },
    onExit(handler) {
      if (ended) {
        queueMicrotask(() => {
          handler(exitCode);
        });
      } else {
        exitHandlers.push(handler);
      }
    },
    kill() {
      stdin.end();
      child.kill("SIGTERM");
    },
  };
}
