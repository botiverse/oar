import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { AuthStatus, LoginAccount } from "../../contracts/login.js";
import { environmentValue } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { asRecord, parseJson } from "../../shared/json.js";

const MAX_CODEX_FILE_BYTES = 1_048_576;
const READ_FLAGS = fsConstants.O_RDONLY | (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0);

export interface CodexAccountMatch {
  readonly email?: string;
}

type BoundedFile = { readonly kind: "ok"; readonly text: string } | { readonly kind: "missing" } | { readonly kind: "unreadable" };

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") { return undefined; }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function codexHomeDirectory(env: Readonly<NodeJS.ProcessEnv>): string {
  const configured = environmentValue(env, "CODEX_HOME");
  return configured !== undefined && configured.length > 0 ? configured : path.join(environmentHome(env), ".codex");
}

async function readBoundedFile(filePath: string): Promise<BoundedFile> {
  let handle: Awaited<ReturnType<typeof open>> | undefined = undefined;
  try {
    handle = await open(filePath, READ_FLAGS);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CODEX_FILE_BYTES) { return { kind: "unreadable" }; }
    return { kind: "ok", text: await handle.readFile("utf8") };
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  } finally {
    await handle?.close().catch(() => { /* ignore close errors after read */ });
  }
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) { escaped = false; }
    else if (quote === '"' && ch === "\\") { escaped = true; }
    else if (quote === ch) { quote = null; }
    else if (quote === null && (ch === '"' || ch === "'")) { quote = ch; }
    else if (quote === null && ch === "#") { return line.slice(0, i); }
  }
  return line;
}

/**
 * Codex defaults `cli_auth_credentials_store` to `"file"` (`AuthCredentialsStoreMode::File`
 * in codex-rs/config/src/types.rs, verified in `codex 0.170.0`). In `"keyring"` or `"auto"`
 * mode, the OS keyring shadows `auth.json`, so fail closed unless every present config layer
 * leaves the store in `"file"` mode.
 */
function configAllowsFileAuthStore(text: string): boolean {
  let inTable = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.startsWith("[")) { inTable = true; }
    if (/\bcli_auth_credentials_store\b/u.test(line) && (inTable || !/^cli_auth_credentials_store\s*=\s*(?:"file"|'file')$/u.test(line))) {
      return false;
    }
  }
  return true;
}

function systemConfigFiles(env: Readonly<NodeJS.ProcessEnv>): readonly string[] {
  if (process.platform === "win32") {
    const programData = environmentValue(env, "ProgramData");
    return programData === undefined || programData.length === 0
      ? []
      : [path.join(programData, "OpenAI", "Codex", "config.toml"), path.join(programData, "OpenAI", "Codex", "managed_config.toml")];
  }
  return ["/etc/codex/config.toml", "/etc/codex/managed_config.toml"];
}

async function isCodexFileAuthStore(env: Readonly<NodeJS.ProcessEnv>, codexHome: string): Promise<boolean> {
  const files = [path.join(codexHome, "config.toml"), ...systemConfigFiles(env)];
  const results = await Promise.all(files.map(async (file) => {
    const result = await readBoundedFile(file);
    return result;
  }));
  return results.every(result => result.kind === "missing" || (result.kind === "ok" && configAllowsFileAuthStore(result.text)));
}

function decodeJwtPayload(token: string): Readonly<Record<string, unknown>> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined || parts[1].length === 0) { return null; }
  try {
    return asRecord(parseJson(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function parseJsonRecord(text: string): Readonly<Record<string, unknown>> | null {
  try { return asRecord(parseJson(text)); } catch { return null; }
}

function verifyTokenClaims(tokens: Readonly<Record<string, unknown>>, accountId: string, match?: CodexAccountMatch): boolean {
  const idToken = tokens.id_token;
  if (typeof idToken !== "string") { return match?.email === undefined; }
  const payload = decodeJwtPayload(idToken);
  if (payload === null) { return false; }
  const authClaim = asRecord(payload["https://api.openai.com/auth"]);
  const claimId = nonEmpty(authClaim?.chatgpt_account_id);
  if (claimId !== undefined && claimId !== accountId) { return false; }
  if (match?.email === undefined) { return true; }
  const tokenEmail = nonEmpty(payload.email);
  return tokenEmail !== undefined && tokenEmail.toLowerCase() === match.email.trim().toLowerCase();
}

/**
 * Read-only lookup of Codex's ChatGPT `tokens.account_id` from `$CODEX_HOME/auth.json`.
 * Fails closed whenever config selects keyring/auto/ephemeral storage or cannot be parsed,
 * when `auth_mode` is not `"chatgpt"`, or when `match.email` disagrees with `tokens.id_token`.
 * Never returns or logs token values.
 */
export async function readCodexAccountId(env: Readonly<NodeJS.ProcessEnv>, match?: CodexAccountMatch): Promise<string | undefined> {
  const codexHome = codexHomeDirectory(env);
  if (!(await isCodexFileAuthStore(env, codexHome))) { return undefined; }
  const file = await readBoundedFile(path.join(codexHome, "auth.json"));
  if (file.kind !== "ok") { return undefined; }
  const root = parseJsonRecord(file.text);
  if (root === null || (root.auth_mode !== undefined && root.auth_mode !== "chatgpt")) { return undefined; }
  const tokens = asRecord(root.tokens);
  const accountId = nonEmpty(tokens?.account_id);
  return tokens !== null && accountId !== undefined && verifyTokenClaims(tokens, accountId, match) ? accountId : undefined;
}

export async function attachCodexAccountId(account: LoginAccount | null, env: Readonly<NodeJS.ProcessEnv>): Promise<LoginAccount | null> {
  if (account === null || account.method !== "chatgpt") { return account; }
  const accountId = await readCodexAccountId(env, account.email === undefined ? undefined : { email: account.email });
  return accountId === undefined ? account : { ...account, accountId };
}

export async function attachCodexStatusAccountId(status: AuthStatus, env: Readonly<NodeJS.ProcessEnv>): Promise<AuthStatus> {
  if (status.kind !== "logged_in" || status.account === undefined) { return status; }
  const account = await attachCodexAccountId(status.account, env);
  return account === null || account === status.account ? status : { ...status, account };
}
