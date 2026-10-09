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
 * OAR sends `env` and `headers` through the runtime's native configuration
 * channel; retained copies of that configuration mask their values. In other
 * record and error text, the shared known-credential rules select values by
 * name and shape (docs/spec/record-stream.md). Ordinary settings such as
 * NODE_ENV and Content-Type remain readable. Values must be strings: null
 * removal belongs to SessionOptions.env, not this native config.
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
  /** Working directory the runtime operates in. With `resume`, a directory other than the session's own is refused where the runtime would run in its own instead (kimi, opencode: `UnsupportedOptionError` on `cwd`); pi and grok can report SessionNotFoundError for that cwd; Cursor reports what its SDK can find with this configuration (docs/runtimes/resume-cwd.md). */
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
  /**
   * Runtime-native service tier, one of the model's `ModelEntry.serviceTiers`,
   * or `default` to explicitly disable a special tier. `default` is an
   * opt-out, not an entry in the catalog. Omission follows the runtime's
   * configuration and restore rules; see its page for resume behavior.
   * Applied at open, including resume; reopen to change it. The adapter reads
   * the native report before returning and rejects a refused or substituted
   * tier instead of silently running another. Runtimes without a verified
   * channel reject with UnsupportedOptionError on serviceTier, declared in
   * Runtime.refusedSessionOptions. A runtime that accepts this option lists
   * its tiers, and one that lists tiers accepts it. Session.serviceTier()
   * folds native reports; provider-side availability can still change later.
   */
  readonly serviceTier?: string;
  /**
   * Resume the native conversation identified by a previous Session.id.
   * Verified missing-target signals reject with SessionNotFoundError; all
   * other failed opens keep their own errors. Missing is scoped to the
   * runtime's configuration, including cwd for per-directory stores. Save
   * and reuse that cwd; kimi/opencode reject a different one with
   * UnsupportedOptionError. See docs/spec/runtime-matrix.md#missing-resume-targets.
   */
  readonly resume?: string;
  /** Environment changes for the processes THIS session spawns: a string sets the variable (including an empty string); null removes it from the inherited environment. The host environment is never changed. Subprocess runtimes: the runtime process itself (tools inherit). In-process runtimes: only the agent's tool subprocesses; provider config needs the runtime's native channel there. CAVEAT for PATH-like entries: a runtime that runs tools through a login shell (codex: zsh/bash -lc) lets profile scripts reorder or rebuild PATH (probed: codex demotes injected entries on Linux and macOS path_helper/.zprofile can drop them). Injected CLIs should be invoked by ABSOLUTE path. Pi refuses removals combined with stdio mcpServers because its MCP transport re-inherits the host environment. Refused when non-empty by cursor, whose tools run in the host process with no environment of their own: `session()` rejects with `UnsupportedOptionError` (`Runtime.refusedSessionOptions`, docs/spec/runtime-matrix.md#refused-session-options).
   *
   * Credential-like names with non-path values of at least eight characters,
   * plus password-bearing connection URLs, are redacted within each OAR
   * record and error; native inputs stay unchanged.
   * Model echoes split across streaming deltas are outside this guarantee:
   * hosts must not rely on this rule to prevent a model from revealing a key.
   * Exact name rules: docs/spec/record-stream.md, "Known session credentials".
   */
  readonly env?: Readonly<Record<string, string | null>>;
  /** REPLACE the runtime's built-in system prompt (claude --system-prompt, codex thread baseInstructions, pi resource-loader systemPrompt). Survives runtime compaction (pinned per vendor). Refused by cursor, kimi and antigravity: `session()` rejects with `UnsupportedOptionError` (`Runtime.refusedSessionOptions`, docs/spec/runtime-matrix.md#refused-session-options). */
  readonly systemPrompt?: string;
  /** APPEND to the runtime's built-in system prompt, keeping its harness behavior intact (claude --append-system-prompt, codex developerInstructions, pi appendSystemPrompt). Survives runtime compaction (pinned per vendor). Refused by cursor, kimi and antigravity: `session()` rejects with `UnsupportedOptionError` (`Runtime.refusedSessionOptions`, docs/spec/runtime-matrix.md#refused-session-options). */
  readonly appendSystemPrompt?: string;
  /**
   * MCP servers attached to THIS session, on top of the servers the runtime
   * is configured with: oar never edits the runtime's configuration or
   * drops the user's servers (claude reads the session's from a 0600 FIFO
   * oar removes once read, on Windows a temporary file removed when claude
   * exits; codex from its `thread/start` / `thread/resume` config
   * overrides; grok, kimi, opencode and antigravity from ACP `session/new` /
   * `session/resume` `mcpServers`; pi from an extension that registers
   * them). Not remembered: give them
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
  /**
   * Runtime-native tool names to disable through the runtime's own deny
   * channel. Names keep the runtime's vocabulary (including MCP names such
   * as `mcp__server__tool`); oar never constructs an allowlist or filters
   * tool events after execution. Give the list again on resume. Omitted or
   * empty means no additional restriction, except that a runtime which saves
   * its filter in the session (antigravity) keeps it when a resume omits the
   * list; an empty list clears it. Unsupported native deny channels
   * reject the open with UnsupportedOptionError. Native matching remains
   * native: Claude and Pi accept unmatched names without disabling anything
   * or reporting an error. See each runtime page for validation and groups. This is tool selection, not an OS
   * sandbox: another allowed tool may provide the same capability.
   */
  readonly disallowedTools?: readonly string[];
  /**
   * Extra command-line arguments for the runtime process this session
   * starts, for a host that knows a runtime flag OAR does not model (for
   * example codex `-c service_tier="fast"`). They go where that runtime's
   * CLI takes options; each runtime page says where. OAR passes them
   * unchecked and promises nothing about their effect: an argument can
   * conflict with one OAR passes, one that changes the protocol OAR speaks
   * (claude's output format, codex's `--listen`) breaks the session, and a
   * flag the runtime does not know usually makes it exit (the open rejects;
   * claude opens with its exit as the first record). OAR's own checks
   * (model, effort and the other typed options read back from the runtime)
   * cover only those options. OAR never records them (no record, event,
   * error or voyage header), though a runtime's own error output can quote
   * them. They are NOT secret: any local user can read a process's argv
   * (`ps`), so credentials belong in `env`. Give them again on resume. Refused when non-empty by runtimes with no
   * process of their own (pi, cursor) and by morph: `session()` rejects with
   * `UnsupportedOptionError` (`Runtime.refusedSessionOptions`).
   */
  readonly launchArgs?: readonly string[];
}
