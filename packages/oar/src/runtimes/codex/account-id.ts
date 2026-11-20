import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { environmentValue } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { asRecord, parseJson } from "../../shared/json.js";

const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const MAX_ACCOUNT_ID_CHARS = 128;

/**
 * Read-only lookup of Codex's ChatGPT `tokens.account_id` from `$CODEX_HOME/auth.json`
 * (default `~/.codex/auth.json`). Never exposes or logs tokens or API keys; returns
 * undefined when the file is absent, unreadable, or holds no ChatGPT account id.
 */
export async function readCodexAccountId(env: Readonly<NodeJS.ProcessEnv>): Promise<string | undefined> {
  const configured = environmentValue(env, "CODEX_HOME");
  const directory = configured === undefined || configured === ""
    ? path.join(environmentHome(env), ".codex")
    : configured;
  const filePath = path.join(directory, "auth.json");
  try {
    const entry = await stat(filePath);
    if (!entry.isFile() || entry.size > MAX_AUTH_FILE_BYTES) { return undefined; }
    // A FIFO replacing a regular file between stat and open must not block the reader.
    const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.size > MAX_AUTH_FILE_BYTES) { return undefined; }
      const root = asRecord(parseJson(await file.readFile("utf8")));
      const raw = asRecord(root?.tokens)?.account_id;
      if (typeof raw !== "string") { return undefined; }
      const trimmed = raw.trim();
      return trimmed.length > 0 && trimmed.length <= MAX_ACCOUNT_ID_CHARS ? trimmed : undefined;
    } finally { await file.close(); }
  } catch { return undefined; }
}
