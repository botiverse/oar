// Kimi's authenticated `/me` profile: the best-effort identity half of account usage.
import { remainingMs } from "../../shared/deadline.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { KIMI_USAGE, type KimiAuthContext } from "./auth-config.js";

export interface KimiAccountIdentity {
  readonly email?: string;
  readonly plan?: string;
  readonly displayName?: string;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Extract identity only from Kimi's authenticated `/me` profile shape. */
export function kimiAccountEmail(payload: unknown): string | undefined {
  const profile = asRecord(payload);
  return text(profile?.user_id) === undefined ? undefined : text(profile?.email);
}

/** Extract the human-readable membership level reported by Kimi's `/me` profile. */
export function kimiAccountPlan(payload: unknown): string | undefined {
  const profile = asRecord(payload);
  return text(profile?.user_id) === undefined ? undefined : text(profile?.user_level_name);
}

/**
 * Extract the profile nickname from Kimi's authenticated `/me` profile. Phone or
 * WeChat sign-ins have no email, so this is often the only readable identity.
 */
export function kimiAccountDisplayName(payload: unknown): string | undefined {
  const profile = asRecord(payload);
  return text(profile?.user_id) === undefined ? undefined : text(profile?.nickname);
}

export async function fetchKimiAccountIdentity(
  auth: KimiAuthContext,
  accessToken: string,
  deadline: number,
): Promise<KimiAccountIdentity> {
  try {
    const response = await fetch(`${auth.baseUrl}/me`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(remainingMs(deadline, KIMI_USAGE)),
    });
    if (!response.ok) {
      return {};
    }
    const profile = parseJson(await response.text());
    const email = kimiAccountEmail(profile);
    const plan = kimiAccountPlan(profile);
    const displayName = kimiAccountDisplayName(profile);
    return {
      ...(email === undefined ? {} : { email }),
      ...(plan === undefined ? {} : { plan }),
      ...(displayName === undefined ? {} : { displayName }),
    };
  } catch {
    // Identity is a best-effort add-on: a missing/older profile endpoint or a
    // transient failure must not discard an otherwise valid quota snapshot.
    return {};
  }
}
