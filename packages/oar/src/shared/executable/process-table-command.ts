import { spawn, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import { trackOwnedProcess } from "./ownership.js";

export const PROCESS_TABLE_TIMEOUT_MS = 5000;
const MAX_OUTPUT = 16 * 1024 * 1024;
export interface ProcessTableReadOptions { readonly background?: boolean; }

/** A query deadline includes pipe drain; a dead root cannot leave this read waiting on close. */
export async function processTableCommand(command: string, args: readonly string[], env?: NodeJS.ProcessEnv, options?: ProcessTableReadOptions): Promise<string> {
  const output = await new Promise<string>((resolve, reject) => {
    // Node's piped-stdio overload excludes the missing pipes of a failed spawn.
    const child: ChildProcess = spawn(command, [...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    trackOwnedProcess(child);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const deadline: { timer?: NodeJS.Timeout } = {};
    const finish = (error?: unknown): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(deadline.timer);
      if (error !== undefined) {
        // Never wait for close after the deadline. Ownership retains the query
        // until close, including when the OS cannot terminate it immediately.
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* Keep the original read failure. */ }
        }
        child.stdout?.destroy();
        reject(error instanceof Error ? error : new Error("Process table query failed"));
      } else { resolve(Buffer.concat(chunks).toString("utf8")); }
    };
    // Failed spawn (including EMFILE/ENFILE) may return no stdout. Register
    // the native error before touching pipes or arming a deadline.
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) { finish(); }
      else { finish(Object.assign(new Error("Process table command failed"), { status: code, signal })); }
    });
    if (options?.background === true) { child.unref(); }
    const stdout = child.stdout;
    if (!stdout) {
      // The native spawn error is queued first; retain its metadata when it
      // arrives, while also settling a malformed spawn with no error event.
      const fallback = setImmediate(() => { finish(new Error("Process table query has no stdout")); });
      if (options?.background === true) { fallback.unref(); }
      return;
    }
    stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { finish(Object.assign(new Error("Process table output exceeded limit"), { code: "ENOBUFS" })); }
      else { chunks.push(chunk); }
    });
    stdout.once("error", finish);
    deadline.timer = setTimeout(() => { finish(Object.assign(new Error("Process table query timed out"), { code: "ETIMEDOUT" })); }, PROCESS_TABLE_TIMEOUT_MS);
    if (options?.background === true) {
      deadline.timer.unref();
      if (stdout instanceof Socket) { stdout.unref(); }
    }
  });
  return output;
}
