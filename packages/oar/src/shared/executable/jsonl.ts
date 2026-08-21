import { spawn } from "node:child_process";
import { asRecord, parseJson, type JsonRecord } from "../json.js";

/**
 * Run one line-delimited JSON exchange against an executable: write the opening
 * message, feed each parsed response line to the handler (which may send
 * further messages), and settle with the handler's first non-null result.
 * Returns null when the process cannot be spawned, exits early, or the timeout
 * elapses before a result.
 */
export async function exchangeJsonl<T>(
  command: string,
  args: readonly string[],
  opening: object,
  handler: (message: JsonRecord, send: (message: object) => void) => T | null,
  timeoutMs: number,
): Promise<T | null> {
  const result = await new Promise<T | null>((resolve) => {
    const child = spawn(command, [...args], {
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let finished = false;
    const finish = (outcome: T | null): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      // oxlint-disable-next-line promise/no-multiple-resolved -- finished is the settlement guard
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);
    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.once("error", () => {
      finish(null);
    });
    child.once("exit", () => {
      finish(null);
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) {
          continue;
        }
        const message = asRecord(parseJson(line));
        if (message === null) {
          continue;
        }
        const outcome = handler(message, send);
        if (outcome !== null) {
          finish(outcome);
        }
      }
    });
    send(opening);
  });
  return result;
}
