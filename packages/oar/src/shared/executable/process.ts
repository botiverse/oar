import { spawn } from "node:child_process";

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

/** Windows npm shims are .cmd/.bat files, which modern Node refuses to spawn without a shell (EINVAL). */
export function requiresShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/iu.test(command);
}

export function spawnLineProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): LineProcess {
  const needsShell = requiresShell(command, process.platform);
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? process.env,
    // OAR_CHILD_STDERR=inherit surfaces child stderr on the parent's — the
    // debugging knob for "the process died and nobody knows why".
    stdio: ["pipe", "pipe", process.env.OAR_CHILD_STDERR === "inherit" ? "inherit" : "ignore"],
    shell: needsShell,
  });
  const lineHandlers: ((line: string) => void)[] = [];
  const exitHandlers: ((code: number | null) => void)[] = [];
  let buffer = "";
  let ended = false;
  const { promise: spawned, resolve: spawnOk, reject: spawnFailed } = Promise.withResolvers<void>();
  const { promise: exited, resolve: exitDone } = Promise.withResolvers<number | null>();
  child.once("spawn", spawnOk);
  const end = (code: number | null): void => {
    if (!ended) {
      ended = true;
      for (const handler of exitHandlers) {
        handler(code);
      }
      exitDone(code);
    }
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
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
    write(text) {
      child.stdin.write(text);
    },
    onLine(handler) {
      lineHandlers.push(handler);
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    kill() {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}
