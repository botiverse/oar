import { processFailure, type ProcessDiagnostics } from "../executable/diagnostics.js";
import { redactTokenShapes } from "../token-redaction.js";

export type AcpErrorKind = "timeout" | "process_exited";

/** One transport error class with a discriminant instead of four nominal wrappers. */
export class AcpError extends Error {
  readonly kind: AcpErrorKind;
  readonly exitCode: number | null;
  readonly method: string | null;
  readonly timeoutMs: number | null;

  constructor(
    kind: AcpErrorKind,
    message: string,
    fields: {
      readonly exitCode?: number | null;
      readonly method?: string;
      readonly timeoutMs?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, fields);
    this.name = "AcpError";
    this.kind = kind;
    this.exitCode = fields.exitCode ?? null;
    this.method = fields.method ?? null;
    this.timeoutMs = fields.timeoutMs ?? null;
  }
}

export function acpRequestTimeoutError(method: string, timeoutMs: number): AcpError {
  return new AcpError("timeout", `ACP request ${method} timed out after ${timeoutMs}ms`, {
    method,
    timeoutMs,
  });
}

export function acpProcessExitedError(
  exitCode: number | null,
  diagnostics?: ProcessDiagnostics,
  redact: (text: string) => string = (text) => text,
): AcpError {
  // Only session opening supplies diagnostics. Authentication queries and
  // later transport failures keep their existing, diagnostic-free errors.
  const safe = (text: string): string => redactTokenShapes(redact(text));
  const failure = diagnostics === undefined ? undefined : processFailure("ACP process exited", {
    ...diagnostics,
    stderr: safe(diagnostics.stderr),
    ...(diagnostics.error === undefined ? {} : { error: { ...diagnostics.error, message: safe(diagnostics.error.message) } }),
  });
  return new AcpError(
    "process_exited",
    failure?.message ?? (exitCode === null ? "ACP process exited" : `ACP process exited with code ${exitCode}`),
    { exitCode, ...(failure === undefined ? {} : { cause: failure.cause }) },
  );
}
