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
    } = {},
  ) {
    super(message);
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

export function acpProcessExitedError(exitCode: number | null): AcpError {
  return new AcpError(
    "process_exited",
    exitCode === null ? "ACP process exited" : `ACP process exited with code ${exitCode}`,
    { exitCode },
  );
}
