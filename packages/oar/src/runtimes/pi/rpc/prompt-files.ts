import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionOptions } from "../../../contracts/session.js";

/** Pi treats an unreadable path as literal prompt text, so verify before spawning. */
export async function piRpcPromptFiles(directory: string, options: SessionOptions): Promise<readonly string[]> {
  const args: string[] = [];
  for (const [flag, name, text] of [
    ["--system-prompt", "system.txt", options.systemPrompt],
    ["--append-system-prompt", "append.txt", options.appendSystemPrompt],
  ] as const) {
    if (text === undefined) { continue; }
    const file = path.join(directory, name);
    await writeFile(file, text, { mode: 0o600, flag: "wx" });
    try {
      if (await readFile(file, "utf8") !== text) { throw new Error("The private prompt file did not retain its contents"); }
    } catch (error) {
      throw new Error(`Pi RPC could not read its private ${name} prompt file; the session process was not started`, { cause: error });
    }
    args.push(flag, file);
  }
  return args;
}
