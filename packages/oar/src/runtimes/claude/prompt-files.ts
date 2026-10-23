import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionOptions } from "../../contracts/session.js";
import { privateTempDir, sweepPrivateTempDirs } from "../../shared/private-temp.js";

const PREFIX = "oar-claude-prompts-";

/** Native file flags avoid exposing prompts in argv and its platform length limits. */
export async function claudePromptFiles(options: SessionOptions): Promise<{ readonly args: readonly string[]; remove(): void } | null> {
  await sweepPrivateTempDirs(PREFIX);
  if (options.systemPrompt === undefined && options.appendSystemPrompt === undefined) { return null; }
  const directory = await privateTempDir(PREFIX);
  try {
    const args: string[] = [];
    for (const [flag, name, text] of [
      ["--system-prompt-file", "system.txt", options.systemPrompt],
      ["--append-system-prompt-file", "append.txt", options.appendSystemPrompt],
    ] as const) {
      if (text === undefined) { continue; }
      const file = path.join(directory.path, name);
      await writeFile(file, text, { mode: 0o600, flag: "wx" });
      args.push(flag, file);
    }
    return { args, remove: () => { directory.remove(); } };
  } catch (error) { directory.remove(); throw error; }
}
