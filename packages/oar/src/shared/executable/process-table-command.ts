import { spawn } from "node:child_process";
import { trackOwnedProcess } from "./ownership.js";

export const PROCESS_TABLE_TIMEOUT_MS = 5000;
const MAX_OUTPUT = 16 * 1024 * 1024;

/** A query deadline includes pipe drain; a dead root cannot leave this read waiting on close. */
export async function processTableCommand(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    trackOwnedProcess(child);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        // Never wait for close after the deadline. Ownership retains the query
        // until close, including when the OS cannot terminate it immediately.
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* Keep the original read failure. */ }
        }
        child.stdout.destroy();
        reject(error instanceof Error ? error : new Error("Process table query failed"));
      } else { resolve(Buffer.concat(chunks).toString("utf8")); }
    };
    const timer = setTimeout(() => { finish(Object.assign(new Error("Process table query timed out"), { code: "ETIMEDOUT" })); }, PROCESS_TABLE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { finish(Object.assign(new Error("Process table output exceeded limit"), { code: "ENOBUFS" })); }
      else { chunks.push(chunk); }
    });
    child.stdout.once("error", finish);
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) { finish(); }
      else { finish(Object.assign(new Error("Process table command failed"), { status: code, signal })); }
    });
  });
  return output;
}
