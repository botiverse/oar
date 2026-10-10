/**
 * Variables a running Claude Code session sets for its own child processes
 * (its Bash tool, hooks): markers of that parent session, not configuration.
 * A host started from inside Claude Code inherits them, and a claude it
 * launches then believes it is part of that session
 * (`CLAUDE_CODE_CHILD_SESSION`: skill proposals off, org memory refused, no
 * prompt history), runs under its entrypoint, or receives the parent's
 * messaging credential. The list is the one claude itself drops when it
 * launches an independent claude (its daemon launcher, 2.1.292), plus the
 * messaging socket and token. `TRACEPARENT` (trace context) and an
 * `AI_AGENT` set by another tool are configuration and pass through (#309).
 */
export const CLAUDE_PARENT_SESSION_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
  "CLAUDE_CODE_EVAL_INTERVIEW_SESSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_HOST_WORKTREE",
  "CLAUDE_CODE_HOST_WORKTREE_FENCE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
] as const;

const removed: Readonly<Record<string, null>> = Object.fromEntries(CLAUDE_PARENT_SESSION_MARKERS.map((name) => [name, null]));

/**
 * A session's environment changes: every inherited parent-session marker
 * removed, then the host's own `SessionOptions.env`, which can set any of them
 * again except `CLAUDECODE` (claude refuses to start nested under it).
 */
export function claudeSessionEnv(env: Readonly<Record<string, string | null>> | undefined): Readonly<Record<string, string | null>> {
  return { ...removed, ...env, CLAUDECODE: null };
}

/** The environment for the claude subcommands OAR runs (auth, usage, model list, inventory): the host's, without parent-session markers. */
export function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CLAUDE_PARENT_SESSION_MARKERS) {
    env[name] = undefined;
  }
  return env;
}
