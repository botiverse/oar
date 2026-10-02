/** A bounded observation of native process failure, not a retry policy. */
export interface ProcessDiagnostics {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly timeoutMs?: number;
  readonly error?: { readonly code?: string; readonly message: string };
}

export const STDERR_TAIL_BYTES = 8192;

/** Copy retained bytes so a small suffix cannot keep a large chunk alive. */
export class StderrTail {
  private bytes: Buffer = Buffer.alloc(0);

  append(chunk: Buffer | string): void {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.bytes = incoming.length >= STDERR_TAIL_BYTES
      ? Buffer.from(incoming.subarray(-STDERR_TAIL_BYTES))
      : Buffer.concat([this.bytes.subarray(Math.max(0, this.bytes.length + incoming.length - STDERR_TAIL_BYTES)), incoming]);
  }

  text(): string {
    // A byte limit can cut through the first UTF-8 character. Omit that
    // incomplete prefix instead of introducing a replacement character.
    let start = 0;
    for (const byte of this.bytes) {
      if ((byte & 0xC0) !== 0x80) {
        break;
      }
      start += 1;
    }
    return this.bytes.subarray(start).toString("utf8");
  }
}

export function stderrTail(text: string): string {
  const tail = new StderrTail();
  tail.append(text);
  return tail.text();
}

export function nativeError(error: Error): { readonly code?: string; readonly message: string } {
  return {
    ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    message: stderrTail(error.message),
  };
}

export function processFailure(context: string, diagnostics: ProcessDiagnostics): Error {
  const reasons = [
    `exit code ${diagnostics.exitCode === null ? "unavailable" : String(diagnostics.exitCode)}`,
    `signal ${diagnostics.signal ?? "none"}`,
  ];
  if (diagnostics.timeoutMs !== undefined) {
    reasons.push(`timeout after ${String(diagnostics.timeoutMs)} ms`);
  }
  if (diagnostics.error !== undefined) {
    reasons.push(`${diagnostics.error.code ?? "native error"}: ${diagnostics.error.message}`);
  }
  const stderr = diagnostics.stderr === "" ? "" : `\nstderr (tail):\n${diagnostics.stderr}`;
  return new Error(`${context}: ${reasons.join("; ")}${stderr}`, { cause: diagnostics });
}
