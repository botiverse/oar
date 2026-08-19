export interface HostDetectMetadata {
  readonly host: string;
  readonly at: string;
  readonly sources: Readonly<Record<string, string>>;
}

/** Explain which live host evidence each runtime definition reads. */
export function collectHostDetectMetadata(): HostDetectMetadata {
  return {
    host: process.env.RAFT_CURRENT_COMPUTER_HOSTNAME ?? process.env.HOSTNAME ?? "local",
    at: new Date().toISOString(),
    sources: {
      codex: "codex --version; models via app-server model/list (cache fallback if app-server fails)",
      claude: "claude --version; models=static aliases+API ids (docs model-config / raft RUNTIME_MODELS) + user-configured; CLAUDE_MODEL_LIST extends",
      grok: "grok --version + grok models",
      opencode: "opencode --version + opencode models",
      pi: "SDK in-process: package version + ModelRuntime.create({allowModelNetwork:false}).getAvailableSnapshot()",
      kimi: "SDK ONLY: version from @botiverse/kimi-code-sdk package (absent if unresolvable); models: $KIMI_CODE_HOME|~/.kimi-code/config.toml [models.*]",
      "kimi-cli": "CLI ONLY: presence/version from $KIMI_CODE_HOME/bin/kimi or PATH kimi --version (absent if no binary); models: same config.toml [models.*]",
      antigravity: "agy --version + agy models (needs_login when sign-in required)",
      copilot: "which copilot",
      cursor: "which cursor-agent",
      gemini: "which gemini",
    },
  };
}
