import type { LoginResult, RuntimeLogin } from "../../contracts/login.js";

/**
 * Antigravity's FAQ warns that using a personal Google account through
 * third-party tools violates its terms of service, so oar does not drive a
 * sign-in. The ACP server oar runs also keeps its own token and redirects
 * only to a loopback listener, with no code to paste back.
 */
export const antigravityLogin: RuntimeLogin = async (): Promise<LoginResult> => {
  await Promise.resolve();
  return {
    kind: "unsupported",
    reason: "terms_of_service",
    detail: "Antigravity's terms do not allow signing a personal account in through third-party tools; configure the ACP server with an API key (gemini-api-key) or Vertex instead",
  };
};
