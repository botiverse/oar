import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateTempDir } from "../../shared/private-temp.js";

/** Keep the prompt out of argv; retain its private file until native exit. */
export async function codebuddyPromptFile(text: string): Promise<{ readonly args: readonly string[]; remove(): void }> {
  const directory = await privateTempDir("oar-codebuddy-prompt-");
  try {
    const file = path.join(directory.path, "system.txt");
    await writeFile(file, text, { flag: "wx", mode: 0o600 });
    if (await readFile(file, "utf8") !== text) { throw new Error("CodeBuddy system prompt file did not retain the supplied text"); }
    return { args: ["--system-prompt-file", file], remove: () => { directory.remove(); } };
  } catch (error) { directory.remove(); throw error; }
}
