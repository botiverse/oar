import type { LineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { PassThrough } from "node:stream";
import { StderrTail, type ProcessDiagnostics } from "../../packages/oar/src/shared/executable/diagnostics.js";
import { cleanupFailureReason, type ProcessCleanupDiagnostics } from "../../packages/oar/src/shared/executable/process-cleanup.js";

export interface FakeLineProcess extends LineProcess {
  /** Emit a raw chunk on stdout; `onLine` handlers see complete lines. */
  emit(chunk: string): void;
  /** End the process with the given code; resolves `exited` and fires `onExit`. */
  end(code: number | null, signal?: NodeJS.Signals | null, cleanup?: ProcessCleanupDiagnostics): void;
  emitStderr(chunk: string): void;
  readonly written: string[];
  killed(): boolean;
}

type WriteHook = (text: string, fake: FakeLineProcess) => void;

class ScriptedLineProcess implements FakeLineProcess {
  readonly spawned = Promise.resolve();
  readonly exited: Promise<number | null>;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly written: string[] = [];
  private readonly lineHandlers: ((line: string) => void)[] = [];
  private readonly exitHandlers: ((code: number | null, reason?: string) => void)[] = [];
  private readonly resolveExit: (code: number | null) => void;
  private readonly onWrite: WriteHook | undefined;
  private pending = "";
  private ended = false;
  private wasKilled = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private cleanup: ProcessCleanupDiagnostics | undefined;
  private readonly stderr = new StderrTail();

  constructor(onWrite: WriteHook | undefined) {
    this.onWrite = onWrite;
    const { promise, resolve } = Promise.withResolvers<number | null>();
    this.exited = promise;
    this.resolveExit = resolve;
    this.stdout.on("data", (chunk: Buffer | string) => {
      this.consume(chunk.toString());
    });
  }

  killed(): boolean {
    return this.wasKilled;
  }

  diagnostics(): ProcessDiagnostics {
    return { exitCode: this.exitCode, signal: this.exitSignal, stderr: this.stderr.text(), ...(this.cleanup === undefined ? {} : { cleanup: this.cleanup }) };
  }

  emitStderr(chunk: string): void {
    this.stderr.append(chunk);
  }

  write(text: string): void {
    this.written.push(text);
    this.onWrite?.(text, this);
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  onExit(handler: (code: number | null, reason?: string) => void): void {
    this.exitHandlers.push(handler);
  }

  kill(): void {
    this.wasKilled = true;
    this.end(null);
  }

  /** A scripted process has no memory of its own to report. */
  readonly resources = async (): Promise<null> => null;

  emit(chunk: string): void {
    this.stdout.write(chunk);
  }

  end(code: number | null, signal: NodeJS.Signals | null = null, cleanup?: ProcessCleanupDiagnostics): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.exitCode = code;
    this.exitSignal = signal;
    this.cleanup = cleanup;
    this.stdout.end();
    this.resolveExit(code);
    for (const handler of this.exitHandlers) {
      handler(code, cleanupFailureReason(cleanup));
    }
  }

  private consume(text: string): void {
    this.pending += text;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      for (const handler of this.lineHandlers) {
        handler(line);
      }
    }
  }
}

export function fakeLineProcess(onWrite?: WriteHook): FakeLineProcess {
  return new ScriptedLineProcess(onWrite);
}
