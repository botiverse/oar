/** Claude prints a manual OAuth link in prose or on its own line. */
export function claudeSignInUrl(line: string): string | undefined {
  for (const [candidate] of line.matchAll(/\bhttps:\/\/[^\s<>"'()[\]{}]+/gu)) {
    const url = URL.parse(candidate);
    if (url === null || url.username !== "" || url.password !== "") { continue; }
    const route = url.origin + url.pathname;
    // The compact link carries the scope prefix and challenge before any named
    // fields. Preserve it verbatim for the browser.
    if (route === "https://claude.ai/oauth/authorize" && /^\?[A-Za-z0-9_-]{44,}(?:&|$)/u.test(url.search)) {
      return candidate;
    }
    if (route !== "https://claude.com/cai/oauth/authorize" && route !== "https://platform.claude.com/oauth/authorize") {
      continue;
    }
    const query = url.searchParams;
    if (query.get("response_type") === "code" && query.get("code_challenge_method") === "S256"
      && query.get("redirect_uri") === "https://platform.claude.com/oauth/code/callback"
      && ["client_id", "state", "code_challenge"].every((key) => (query.get(key) ?? "") !== "")) {
      return candidate;
    }
  }
  return undefined;
}
