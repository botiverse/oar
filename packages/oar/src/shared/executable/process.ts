import spawn from "cross-spawn";
import type { Readable, Writable } from "node:stream";

interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** A long-lived child process whose piped stdio is consumed by a protocol SDK. */
export interface StreamProcess {
  readonly spawned: Promise<void>;
  readonly exited: Promise<number | null>;
  readonly stdin: Writable;
  readonly stdout: Readable;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

/**
 * A long-lived child process spoken to line-by-line — the transport shape both
 * session adapters use (JSONL protocols over stdio). Owns the details raw
 * spawn callers keep re-implementing: stdio wiring, line buffering with a
 * trailing partial buffer, exit fan-out, teardown, and the Windows quirk that
 * npm-installed CLIs are .cmd shims which modern Node refuses to spawn without
 * a shell (EINVAL). Windows handling follows Node's documented `shell` option
 * and is honest about being untested here (no Windows machine in the loop).
 */
export interface LineProcess {
  /** Resolves once the OS process exists; rejects when it cannot be spawned. */
  readonly spawned: Promise<void>;
  /** Resolves when the process is truly gone — the release point for any state it held (locks, sockets). */
  readonly exited: Promise<number | null>;
  write(text: string): void;
  onLine(handler: (line: string) => void): void;
  /** Fires exactly once, for exit or spawn-level error alike. */
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

/** Windows npm shims are .cmd/.bat files, which modern Node refuses to spawn without a shell (EINVAL). Line processes go through cross-spawn instead (correct cmd arg quoting); this predicate remains for one-shot execFile calls, whose args must stay SINGLE-WORD on Windows because shell:true does not quote. */
export function requiresShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/iu.test(command);
}

export function spawnLineProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): LineProcess {
  const process = spawnStreamProcess(command, args, options);
  const { stdin, stdout } = process;
  const lineHandlers: ((line: string) => void)[] = [];
  let buffer = "";
  stdout.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
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

  return {
    spawned: process.spawned,
    exited: process.exited,
    write(text) {
      stdin.write(text);
    },
    onLine(handler) {
      lineHandlers.push(handler);
    },
    onExit: (handler) => {
      process.onExit(handler);
    },
    kill: () => {
      process.kill();
    },
  };
}

/**
 * Spawn a child with raw piped stdin/stdout. Protocol framing deliberately
 * belongs to the caller's SDK; this helper owns only cross-platform process
 * launch and lifecycle fan-out.
 */
export function spawnStreamProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): StreamProcess {
  // cross-spawn, not node's spawn: Windows .cmd shims need a shell, and
  // node's shell:true joins args UNQUOTED — a multi-word argument (e.g. a
  // --system-prompt value) silently truncates at its first space (caught by
  // the system-prompt snapshots on Windows CI). cross-spawn does the cmd
  // escaping correctly and is a no-op wrapper elsewhere.
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? process.env,
    // OAR_CHILD_STDERR=inherit surfaces child stderr on the parent's — the
    // debugging knob for "the process died and nobody knows why".
    stdio: ["pipe", "pipe", process.env.OAR_CHILD_STDERR === "inherit" ? "inherit" : "ignore"],
  });
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) {
    throw new Error("stream process stdio must be piped");
  }
  const exitHandlers: ((code: number | null) => void)[] = [];
  let ended = false;
  let exitCode: number | null = null;
  const { promise: spawned, resolve: spawnOk, reject: spawnFailed } = Promise.withResolvers<void>();
  const { promise: exited, resolve: exitDone } = Promise.withResolvers<number | null>();
  child.once("spawn", spawnOk);
  const end = (code: number | null): void => {
    if (!ended) {
      ended = true;
      exitCode = code;
      for (const handler of exitHandlers) {
        handler(code);
      }
      exitDone(code);
    }
  };

  child.on("exit", (code) => {
    end(code);
  });
  child.on("error", (error) => {
    spawnFailed(error);
    end(null);
  });

  return {
    spawned,
    exited,
    stdin,
    stdout,
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
