import { vi } from "vitest";

/** Keep stored-auth fixtures independent of ambient credentials for these providers. */
export default function clearPiProviderCredentials(): void {
  for (const name of [
    "DEEPSEEK_API_KEY",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID",
  ]) {
    vi.stubEnv(name, undefined);
  }
}
