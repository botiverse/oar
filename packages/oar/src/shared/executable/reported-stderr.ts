import { redactTokenShapes } from "../token-redaction.js";

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
