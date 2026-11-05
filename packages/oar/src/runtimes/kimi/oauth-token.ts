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
 * the Kimi CLI, so oar never refreshes or rewrites it; a stale token surfaces
 * as the usage endpoint's 401/403, which callers map to reauth_required.
 */
export async function storedKimiAccessToken(auth: KimiAuthContext): Promise<string> {
  const accessToken = await readAccessToken(auth.credentialPath);
  if (accessToken === undefined) {
    throw new KimiReauthError("No Kimi OAuth token is stored");
  }
  return accessToken;
}

const systemErrorCodes = new Set([...getSystemErrorMap().values()].map(([code]) => code));

async function readAccessToken(path: string): Promise<string | undefined> {
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
  const token = text(asRecord(parsed)?.access_token);
  if (token === undefined) { throw new Error("Kimi OAuth credential file has no usable access_token"); }
  return token;
}
