import { redactTokenShapes } from "../token-redaction.js";
import { processFailure, type ProcessDiagnostics } from "./diagnostics.js";

interface StderrObservation {
  readonly stderr: string;
  readonly stderrStartsMidLine?: true;
}

/** Redact before shortening. A byte tail can begin inside a credential that no longer matches the redactor. */
export function reportedStderr(observation: StderrObservation, redact?: (text: string) => string): string {
  let text = observation.stderr;
  if (observation.stderrStartsMidLine === true) {
    const newline = text.indexOf("\n");
    text = newline === -1 ? "" : text.slice(newline + 1);
  }
  return redactTokenShapes(redact?.(text) ?? text);
}

/** Enrich the same open error so its class, code and native cause survive. */
export function appendStartupStderr(error: unknown, observation: StderrObservation, redact?: (text: string) => string): unknown {
  const tail = reportedStderr(observation, redact).trimEnd();
  if (!tail) { return error; }
  const failure = error instanceof Error ? error : new Error(String(error));
  if (!failure.message.includes(tail)) {
    const detail = `\nstderr (tail):\n${tail}`;
    const stack = failure.stack;
    failure.message += detail;
    if (stack !== undefined) { failure.stack = stack + detail; }
  }
  return failure;
}

/** A control request failed with its child. Its Error and cause must contain only reportable facts. */
export function reportedProcessFailure(context: string, diagnostic: ProcessDiagnostics, redact?: (text: string) => string): Error {
  const error = diagnostic.error;
  return processFailure(context, {
    ...diagnostic,
    stderr: reportedStderr(diagnostic, redact),
    ...(error === undefined ? {} : { error: { ...error, message: redactTokenShapes(redact?.(error.message) ?? error.message) } }),
  });
}

/** The exited response already carries the exit code. Add the signal and this session's safe stderr when observed. */
export function sessionExitReason(
  child: { stopping(): boolean; diagnostics(): ProcessDiagnostics }, cleanup: string | undefined, redact: (text: string) => string,
): string | undefined {
  if (child.stopping()) { return cleanup; }
  const observed = child.diagnostics();
  const stderr = reportedStderr(observed, redact).trimEnd();
  const details = [cleanup, observed.signal === null ? undefined : `signal ${observed.signal}`, stderr ? `stderr (tail):\n${stderr}` : undefined]
    .filter(value => value !== undefined);
  return details.length > 0 ? details.join("; ") : undefined;
}
