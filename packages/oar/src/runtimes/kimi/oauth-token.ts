import { readFile } from "node:fs/promises";
import { asRecord, parseJson } from "../../shared/json.js";
import type { KimiAuthContext } from "./auth-config.js";

/** The stored credential is unusable; the account needs `kimi` re-auth. */
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

async function readAccessToken(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return text(asRecord(parseJson(raw))?.access_token);
  } catch {
    return undefined;
  }
}
