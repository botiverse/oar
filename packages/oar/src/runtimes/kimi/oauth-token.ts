import { readFile } from "node:fs/promises";
import { getSystemErrorMap } from "node:util";
import { asRecord, parseJson } from "../../shared/json.js";
import type { KimiAuthContext } from "./auth-config.js";

/** The credential file is absent; the account needs `kimi` re-auth. */
export class KimiReauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KimiReauthError";
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read Kimi's stored OAuth access token as-is. The credential store belongs to
 * the Kimi CLI, so oar never refreshes or rewrites it.
 */
export async function storedKimiAccessToken(auth: KimiAuthContext): Promise<string> {
  const token = await readKimiToken(auth);
  const accessToken = token?.revoked === true ? undefined : token?.accessToken;
  if (accessToken === undefined) {
    throw new KimiReauthError("No Kimi OAuth token is stored");
  }
  return accessToken;
}

const systemErrorCodes = new Set([...getSystemErrorMap().values()].map(([code]) => code));

export interface KimiStoredToken { readonly accessToken: string; readonly refreshable: boolean; readonly expiresAt?: number; readonly revoked: boolean }

/** Read only: Kimi owns refresh, locking and writes to this file. */
export async function readKimiToken(auth: KimiAuthContext): Promise<KimiStoredToken | undefined> {
  const path = auth.credentialPath;
  let raw = "";
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    const code = asRecord(error)?.code;
    if (code === "ENOENT") { return undefined; }
    const reason = typeof code === "string" && systemErrorCodes.has(code) ? code : "unknown I/O error";
    // Native errors carry a path; parser errors can quote token bytes. Neither is a safe cause.
    // oxlint-disable-next-line preserve-caught-error -- The native cause can expose the credential path; retain only its system error code.
    throw new Error(`Kimi OAuth credential file could not be read (${reason})`);
  }
  const parsed = parseJson(raw);
  if (parsed === undefined) { throw new Error("Kimi OAuth credential file is not valid JSON"); }
  const row = asRecord(parsed);
  if (row?.access_token === "" && row.refresh_token === "" && row.expires_at === 0) { return { accessToken: "", refreshable: false, expiresAt: 0, revoked: true }; }
  const accessToken = text(row?.access_token);
  if (accessToken === undefined) { throw new Error("Kimi OAuth credential file has no usable access_token"); }
  return { accessToken, refreshable: text(row?.refresh_token) !== undefined, revoked: false,
    ...(typeof row?.expires_at === "number" && Number.isFinite(row.expires_at) ? { expiresAt: row.expires_at } : {}) };
}
