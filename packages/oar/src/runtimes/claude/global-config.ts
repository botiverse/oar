import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { environmentValue } from "../../shared/environment.js";

/** A field from Claude's global preferences in the environment used by the native command. */
export async function readClaudeConfigField(env: NodeJS.ProcessEnv, field: "oauthAccount" | "cachedGrowthBookFeatures"): Promise<unknown> {
  const home = environmentValue(env, process.platform === "win32" ? "USERPROFILE" : "HOME");
  const config = environmentValue(env, "CLAUDE_CONFIG_DIR");
  const directory = config === undefined || config === "" ? home : config;
  const filePath = path.join(directory === undefined || directory === "" ? homedir() : directory, ".claude.json");
  try {
    const entry = await stat(filePath);
    if (!entry.isFile()) { return undefined; }
    // A FIFO replacing a regular file between stat and open must not block the reader.
    const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      if (!opened.isFile()) { return undefined; }
      const record: unknown = JSON.parse(await file.readFile("utf8"));
      const value: unknown = typeof record === "object" && record !== null ? Reflect.get(record, field) : undefined;
      return value;
    } finally { await file.close(); }
  } catch { return undefined; }
}
