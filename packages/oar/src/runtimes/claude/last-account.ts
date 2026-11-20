import type { LastAccount } from "../../contracts/login.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { readClaudeConfigField } from "./global-config.js";

/** Claude Code's native validation pattern for `oauthAccount.planDisplayName` (verified on 2.1.329). */
const PLAN_DISPLAY_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} .+-]{0,38}[\p{L}\p{N}+])?$/u;

export interface ClaudeAccountIdentity {
  readonly email?: string;
  readonly orgId?: string;
  readonly orgName?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function matchesSignedInAccount(stored: JsonRecord, identity: ClaudeAccountIdentity): boolean {
  const signedOrgId = text(identity.orgId);
  const storedOrgId = text(stored.organizationUuid);
  const signedEmail = text(identity.email)?.toLowerCase();
  const storedEmail = text(stored.emailAddress)?.toLowerCase();
  const signedOrgName = text(identity.orgName);
  const storedOrgName = text(stored.organizationName);
  if (signedOrgId !== undefined && storedOrgId !== undefined && signedOrgId !== storedOrgId) { return false; }
  if (signedEmail !== undefined && storedEmail !== undefined && signedEmail !== storedEmail) { return false; }
  if (signedOrgName !== undefined && storedOrgName !== undefined && signedOrgName !== storedOrgName) { return false; }
  return (signedOrgId !== undefined && storedOrgId !== undefined)
    || (signedEmail !== undefined && storedEmail !== undefined);
}

/** Claude can retain its account profile after its refresh grant is rejected. */
export async function rememberedClaudeAccount(env: NodeJS.ProcessEnv): Promise<LastAccount | undefined> {
  const account = asRecord(await readClaudeConfigField(env, "oauthAccount"));
  if (account === null) { return undefined; }
  const email = text(account.emailAddress);
  const displayName = text(account.displayName);
  if (email === undefined && displayName === undefined) { return undefined; }
  return { ...(email === undefined ? {} : { email }), ...(displayName === undefined ? {} : { displayName }) };
}

export interface ClaudeAccountProfile {
  readonly planDisplayName?: string;
  readonly accountId?: string;
}

/**
 * Local non-credential profile fields from `.claude.json` `oauthAccount`:
 * validated `planDisplayName` and stable `accountUuid`, used only when the
 * stored record matches the currently signed-in account by email or orgId.
 */
export async function claudeAccountProfile(
  env: NodeJS.ProcessEnv,
  identity: ClaudeAccountIdentity,
): Promise<ClaudeAccountProfile> {
  const account = asRecord(await readClaudeConfigField(env, "oauthAccount"));
  if (account === null || !matchesSignedInAccount(account, identity)) { return {}; }
  const rawPlan = account.planDisplayName;
  const planDisplayName = typeof rawPlan === "string" && PLAN_DISPLAY_NAME.test(rawPlan) ? rawPlan : undefined;
  const accountId = text(account.accountUuid);
  return {
    ...(planDisplayName === undefined ? {} : { planDisplayName }),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

/**
 * Claude Code's UI plan name (`oauthAccount.planDisplayName` in `.claude.json`),
 * validated against Claude's own regex and used only when `.claude.json` matches
 * the currently signed-in account by email or orgId.
 */
export async function claudePlanDisplayName(
  env: NodeJS.ProcessEnv,
  identity: ClaudeAccountIdentity,
): Promise<string | undefined> {
  const profile = await claudeAccountProfile(env, identity);
  return profile.planDisplayName;
}
