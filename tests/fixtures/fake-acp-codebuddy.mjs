/* oxlint-disable typescript/no-unsafe-call -- Untyped native-process fixture callback. */
// CodeBuddy 2.178.1 extension envelopes from native extNotification call sites.
export default function codebuddyOpening(mode, send) {
  if (mode !== "codebuddy-zero-context") { return; }
  send({ jsonrpc: "2.0", method: "_codebuddy.ai/authUrl", params: { authUrl: "https://example.invalid/?state=private-browser-state", provider: "external" } });
  send({ jsonrpc: "2.0", method: "_codebuddy.ai/command", params: { sessionId: "fake-session", action: "workspace_info", params: { isGitWorkspace: false } } });
}
