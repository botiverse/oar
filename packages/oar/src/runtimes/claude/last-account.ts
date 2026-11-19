import type { LastAccount } from "../../contracts/login.js";
import { readClaudeConfigField } from "./global-config.js";

/** Claude can retain its account profile after its refresh grant is rejected. */
export async function rememberedClaudeAccount(env: NodeJS.ProcessEnv): Promise<LastAccount | undefined> {
  const account = await readClaudeConfigField(env, "oauthAccount");
  if (typeof account !== "object" || account === null) { return undefined; }
  const email = "emailAddress" in account && typeof account.emailAddress === "string" ? account.emailAddress.trim() : "";
  const displayName = "displayName" in account && typeof account.displayName === "string" ? account.displayName.trim() : "";
  if (!email && !displayName) { return undefined; }
  return { ...(email ? { email } : {}), ...(displayName ? { displayName } : {}) };
}
