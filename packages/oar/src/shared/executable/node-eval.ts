import { asRecord } from "../json.js";

/**
 * The executable that evaluates `-e SCRIPT` as Node: this host's own
 * `process.execPath`, or null when the host is a compiled single executable
 * (a Node single executable application, or a Bun standalone executable),
 * whose `process.execPath` runs the application's own entry instead, so
 * starting it would reenter the application. A Bun build that does not say
 * whether it is standalone counts as one.
 */
export function nodeEvalExecutable(): string | null {
  const bun = asRecord(Reflect.get(globalThis, "Bun"));
  if (bun !== null) { return bun.isStandaloneExecutable === false ? process.execPath : null; }
  return process.getBuiltinModule("node:sea").isSea() ? null : process.execPath;
}
