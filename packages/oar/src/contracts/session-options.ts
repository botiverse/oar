/*
 * How a session opens: the options every runtime's `session()` takes, and
 * the MCP servers one can attach. What a runtime cannot honor is refused
 * (`UnsupportedOptionError`, `Runtime.refusedSessionOptions`).
 */

/**
 * One MCP server a session attaches (`SessionOptions.mcpServers`), in ACP's
 * `McpServer` shape: a stdio server the runtime starts (`command`, `args`,
 * `env`), or a streamable HTTP one (`type: "http"`, `url`, `headers`). No
 * SSE: the MCP spec deprecates it. `name` is the server's name in the
 * runtime, the one its tools are known by (claude: `mcp__<name>__<tool>`).
 *
 * `env` and `headers` values are credentials: oar writes them only to the
 * runtime's native channel and never into a record, event or error, which
 * keep the key names at most (a value as `[redacted]`).
 */
export type McpServer =
  | { readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
  | { readonly name: string; readonly type: "http"; readonly url: string; readonly headers?: Readonly<Record<string, string>> };

/**
 * How a session opens. What a runtime cannot honor is refused, never
 * dropped: `session()` rejects with an `UnsupportedOptionError` naming the
 * option rather than open a session that runs without it. A host that must
 * decide before opening reads `Runtime.refusedSessionOptions`
 * (docs/spec/runtime-matrix.md#refused-session-options).
 */
export interface SessionOptions {
  /** Working directory the runtime operates in. With `resume`, a directory other than the session's own is refused where the runtime would run in its own instead (kimi, opencode: `UnsupportedOptionError` on `cwd`); cursor, pi and grok refuse it with their own error (docs/runtimes/resume-cwd.md). */
  readonly cwd: string;
  /** Runtime-native model identifier; the runtime's default when omitted. */
  readonly model?: string;
  /**
   * Runtime-native reasoning-effort level for every turn of this Session, one
   * of the chosen model's `ModelEntry.effortLevels`. Applied at open, with or
   * without `resume`: a resumed session runs at the level given here. When
   * omitted the runtime chooses (its default, or on resume what it restores;
   * the runtime pages say which).
   *
   * Invariant: a runtime whose `listModels` reports `effortLevels` accepts
   * `effort`, and a runtime that accepts it lists the levels. A requested
   * effort is never ignored: the adapter applies it through the runtime's
   * native channel and reads the runtime's own report back. A runtime with no
   * effort channel at all (antigravity) rejects with an
   * `UnsupportedOptionError` on `effort`. When the runtime refuses the level,
   * or would run another one (drop it for the model, clamp it, fall back to
   * its default), starting the session rejects with an Error naming the
   * requested level and what the runtime did instead. A runtime that forwards the level unchecked (codex)
   * reads it back as given, and its provider's refusal fails the first turn.
   * `Session.effort()` is the runtime's report, where it gives one.
   */
  readonly effort?: string;
  /** Resume the runtime-native session identified by a previous Session.id. In a `cwd` other than the session's own, see `cwd`: kimi and opencode refuse it with `UnsupportedOptionError` (docs/spec/runtime-matrix.md#refused-session-options). */
  readonly resume?: string;
  /** Extra environment overlaid on the host env for the processes THIS session spawns. Subprocess runtimes: the runtime process itself (tools inherit). In-process runtimes: only the agent's tool subprocesses; provider config needs the runtime's native channel there. CAVEAT for PATH-like entries: a runtime that runs tools through a login shell (codex: zsh/bash -lc) lets profile scripts reorder or rebuild PATH (probed: codex demotes injected entries on Linux and macOS path_helper/.zprofile can drop them). Injected CLIs should be invoked by ABSOLUTE path. Refused when non-empty by cursor, whose tools run in the host process with no environment of their own: `session()` rejects with `UnsupportedOptionError` (`Runtime.refusedSessionOptions`, docs/spec/runtime-matrix.md#refused-session-options). */
  readonly env?: Readonly<Record<string, string>>;
  /** REPLACE the runtime's built-in system prompt (claude --system-prompt, codex thread baseInstructions, pi resource-loader systemPrompt). Survives runtime compaction (pinned per vendor). Refused by cursor, kimi and antigravity: `session()` rejects with `UnsupportedOptionError` (`Runtime.refusedSessionOptions`, docs/spec/runtime-matrix.md#refused-session-options). */
  readonly systemPrompt?: string;
  /** APPEND to the runtime's built-in system prompt, keeping its harness behavior intact (claude --append-system-prompt, codex developerInstructions, pi appendSystemPrompt). Survives runtime compaction (pinned per vendor). Refused by cursor, kimi and antigravity: `session()` rejects with `UnsupportedOptionError` (`Runtime.refusedSessionOptions`, docs/spec/runtime-matrix.md#refused-session-options). */
  readonly appendSystemPrompt?: string;
  /**
   * MCP servers attached to THIS session, on top of the servers the runtime
   * is configured with: oar never edits the runtime's configuration or
   * drops the user's servers (claude reads the session's from a 0600
   * temporary file oar deletes when the session ends; codex from its
   * `thread/start` / `thread/resume` config overrides; grok, kimi, opencode
   * and antigravity from ACP `session/new` / `session/resume` `mcpServers`;
   * pi from an extension that registers them). Not remembered: give them
   * again on `resume`, where oar attaches them to the resumed session too. A
   * server named like one the user configured meets it the runtime's way for
   * this session (codex: merged into it field by field; pi: the open fails
   * on a name another extension registered; the others: the session's
   * replaces it), measured on each runtime page. A stdio server
   * gets `env` on top of what the runtime passes it (claude and pi: the whole
   * environment, `SessionOptions.env` included; codex: an allowlist such as
   * `HOME` and `PATH`). Names are unique within the list. Refused when
   * non-empty by cursor: `session()` rejects with `UnsupportedOptionError`
   * (`Runtime.refusedSessionOptions`,
   * docs/spec/runtime-matrix.md#refused-session-options), as it does for a
   * transport a runtime cannot attach (http on an ACP agent whose
   * `initialize` declares no `mcpCapabilities.http`) and for an entry with
   * `env` or `headers` on antigravity, which would write them to its disk.
   */
  readonly mcpServers?: readonly McpServer[];
}
