/**
 * The node/POSIX ProcessHost — the ONE concrete OS-spawn backend.
 *
 * This is the single-enforcement-path the trait exists for: every subprocess
 * runtime spawns through here, so a driver cannot self-`spawn` and bypass the
 * shared env/stderr handling. Adding Windows means adding another ProcessHost
 * beside this one, not editing any driver.
 *
 * ⚠️ Scope: this is the minimal shared spawn. Tree-cleanup enumeration is not
 * portably available here, so `stop()` reports `TreeCleanup.unknown` rather than
 * claiming a cleanup it did not observe (per lifecycle.ts: an unmeasured thing
 * must not be reported as a measured absence). A richer POSIX process-group kill
 * is a follow-on; it does not change this contract.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Diagnostic } from "../../events/diagnostic.js";
import type {
  LaunchSpec,
  ProcessHandle,
  ProcessHost,
  ProcessOutcome,
  StopIntent,
  Transport,
} from "./lifecycle.js";

interface ExitState {
  readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  settled: boolean;
}

function trackExit(child: ChildProcessWithoutNullStreams): ExitState {
  const state: ExitState = {
    settled: false,
    done: new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        state.settled = true;
        resolve({ code, signal });
      });
    }),
  };
  return state;
}

function makeTransport(child: ChildProcessWithoutNullStreams): Transport {
  return {
    send(line: string): void {
      child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    async *lines(): AsyncIterable<string> {
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += (chunk as Buffer | string).toString();
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim() !== "") yield line;
        }
      }
      const tail = buffer.trim();
      if (tail !== "") yield tail;
    },
  };
}

function waitMs(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref?.();
  });
}

function makeHandle(child: ChildProcessWithoutNullStreams): ProcessHandle {
  const exit = trackExit(child);
  return {
    transport: makeTransport(child),

    async *drainDiagnostics() {
      // Bounded + scrubbed at the only construction point. Raw stderr never
      // escapes as text; each chunk becomes a typed Diagnostic.
      for await (const chunk of child.stderr) {
        yield Diagnostic.fromRaw("unknown", (chunk as Buffer | string).toString());
      }
    },

    async stop(intent: StopIntent): Promise<ProcessOutcome> {
      if (intent.kind === "graceful") {
        child.kill("SIGTERM");
        const raced = await Promise.race([exit.done, waitMs(intent.waitMs)]);
        if (raced === "timeout") {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      const raced = await Promise.race([exit.done, waitMs(2_000)]);
      if (raced === "timeout") {
        return {
          kind: "stalled",
          tree: { kind: "unknown" },
          diagnostic: Diagnostic.fromRaw("stalled", "process did not exit after stop"),
        };
      }
      return {
        kind: "exited",
        code: raced.code ?? -1,
        tree: { kind: "unknown" },
      };
    },
  };
}

export function nodeProcessHost(): ProcessHost {
  return {
    async spawn(spec: LaunchSpec): Promise<ProcessHandle> {
      const child = spawn(spec.command, [...spec.args], {
        stdio: ["pipe", "pipe", "pipe"],
        // LaunchSpec.env overlays the ambient env for per-runtime isolation
        // (its own HOME/config dir). Ambient PATH etc. must survive so the
        // command resolves.
        env: { ...process.env, ...spec.env },
      }) as ChildProcessWithoutNullStreams;

      // A spawn that fails (e.g. ENOENT) emits `error` and may never emit
      // `exit`. Surfacing it here is the loud-absence rule from the drydock
      // probe: a missing runtime must fail, never come back "started".
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (err) => reject(err));
      });

      return makeHandle(child);
    },
  };
}
