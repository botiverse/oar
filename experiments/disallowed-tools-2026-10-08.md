# Native tool denial, 2026-10-08

`SessionOptions.disallowedTools` passes names to a native deny channel. It
never removes tool events after execution, computes a complementary allowlist,
or replaces the user's agent profile. Supply it again on resume. An empty
list adds no restriction; Antigravity explicitly clears its saved filter.

## Observations

| Runtime | Native channel and evidence | Accepted scope |
|---|---|---|
| Claude 2.1.293 | `--disallowed-tools`; actual Messages requests on create/resume omit `Bash` and `mcp__blocked__echo`, retaining `Read` and `mcp__allowed__echo` | Native CLI names and native matching semantics |
| Pi SDK 1.0.4 | `createAgentSessionFromServices({excludeTools})`; actual Messages requests omit `bash` and a directly registered MCP tool on create/resume, retaining read and the other MCP tool | Native SDK names/patterns; registry filtering also covers the environment-aware Bash override and later MCP registration |
| Cursor SDK 1.0.36 | `Agent.create/resume({disallowedTools})`; real backend baseline executes shell, MCP echo callback and read; restricted new/resumed agents execute only read, with callback count unchanged | SDK local tool names / protobuf names. `shell` includes stdin; `mcp` is the entire MCP family. Native Task children keep a separate toolset; deny `task` to prevent delegation |
| Codex 0.161.0 | Effective `config/read`, then session `config.mcp_servers.<server>.disabled_tools`; actual Responses requests omit the blocked MCP namespace, keep the other, and preserve an existing user's denial on create/resume | Qualified `mcp__server__tool` with an unambiguous, unmodified configured or session server namespace. Built-ins and unresolved names refuse |
| Antigravity 1.3.0 | ACP `_meta.agy.disabledTools`; actual Gemini requests omit `run_command` and `view_file`, retaining `write_to_file`, on create/resume | Canonical `BuiltinTools` filter identifiers only; MCP, client tools and unknown entries refuse before launch |
| Grok 1.0.46 | CLI help and source audit: the top-level `--disallowed-tools` is used by the pager/headless path, not `Command::Agent` / `run_agent_command` | Non-empty lists refused; an agent-profile replacement is outside the option's scope |
| Kimi 2.1.1 | CLI help and source audit: profile `disallowedTools` exists, but `kimi acp` launches `runAcpServer` without root CLI profile options or a session denial overlay | Non-empty lists refused |
| OpenCode 1.18.35 | Native permission source audit: agent rules are appended after global rules; permission evaluation selects the last match. Tool names also map to permission groups | Non-empty lists refused; no replacement of user agents or simulated allowlist |

Claude, Pi, Codex and Antigravity tests run the **real binary/SDK** against a
scripted provider. They compare actual outgoing tool declarations, with a
positive baseline and unrelated tools left available. They also check empty
lists and native session continuity. Codex preserves existing `disabled_tools`
and compares the native config file byte-for-byte after the baseline's first
thread has established native workspace trust. It copies no other config
fields or credentials into the session override.

Cursor is a live model comparison, not a scripted provider or an exhaustive
proof of every backend tool. Its source independently resolves the SDK's
names to protobuf names and forwards them as
`x-cursor-agent-exclude-tools`; the measured groups are shell and MCP.
Unknown name validation occurs at create/resume; OAR converts that native
`ConfigurationError` to `UnsupportedOptionError`, retaining the named entries.
The first probe attempt used the wrong OAR event property (`name` instead of
`tool`); the corrected run observed `[shell,mcp,read]`, `[read]`, `[read]`, with
one total echo callback. No runtime change was needed for that probe error.

Antigravity's filter names are the native enum, not every concrete tool call
name: `create_file` controls `write_to_file`, for example. Native unknown names
are otherwise logged and skipped, so OAR validates the known enum values
before launch. The filter does not cover MCP or client filesystem callbacks.
OAR's ACP client advertises no filesystem callbacks. Authentication and the
live Gemini service are not exercised by this scripted-provider check.

## Reproduce

Run the vendor test for the named backend, pinning its executable with the
usual `OAR_*_BIN` variable. Pi uses the bundled SDK and an isolated model home.

```sh
OAR_TEST=claude-aimock pnpm exec vitest run sea-trial/vendor/disallowed-tools.vendor.test.ts
OAR_TEST=pi-aimock OAR_TEST_MODEL=aimock/aimock-model pnpm exec vitest run sea-trial/vendor/disallowed-tools.vendor.test.ts
OAR_TEST=codex-aimock pnpm exec vitest run sea-trial/vendor/disallowed-tools-codex.vendor.test.ts
OAR_TEST=antigravity-aimock pnpm exec vitest run sea-trial/vendor/disallowed-tools-antigravity.vendor.test.ts
pnpm tsx experiments/cursor-disallowed-tools.ts
```

The Cursor command requires a real login and uses model tokens. The others
use local providers and dummy credentials. Unit tests cover refusal maps,
mixed-name rejection, immutable inputs, native Cursor error conversion and
preservation of Codex configuration fields. Revisit refused channels when
upstream adds a session-level overlay.

## Native sources

- Claude's distributed `claude --help` at 2.1.293 declares both spellings
  `--disallowedTools` and `--disallowed-tools`.
- Pi's distributed SDK 1.0.4 `core/agent-session-services.js`, `core/sdk.js`
  and `core/agent-session.js`: `excludeTools`, `_excludedTools`,
  `_isAllowedTool` and registry refresh after extension registration.
- Cursor's distributed SDK 1.0.36 `options.d.ts` and bundled
  `src/agent/tools-option.ts`: native tool-name resolver, shell/MCP group
  expansion and the exclude-tools request header.
- [Codex 0.161.0 configuration schema](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/config.schema.json),
  `RawMcpServerConfig.disabled_tools`, plus the same binary's generated
  `ConfigReadParams` and `ConfigReadResponse` app-server schemas.
- [Grok source snapshot](https://github.com/xai-org/grok-build/tree/77cd7eb675ba911c225c3aaeeece3a20cbccc426/crates/codegen):
  `xai-grok-pager-bin/src/main.rs` (`Command::Agent`, `run_agent_command`),
  `xai-grok-shell/src/agent/config.rs` (`CliAgentOverrides`) and
  `mvp_agent/agent_ops.rs` (`resolve_agent_definition`).
- [Kimi source snapshot](https://github.com/MoonshotAI/kimi-code/tree/0999454bdcb5ddd98f39bffee434dcf0a810f394):
  `apps/kimi-code/src/cli/sub/acp-native.ts` and
  `packages/agent-core-v2/src/agent/profile/profile.ts`.
- [OpenCode 1.18.35 agent configuration](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/agent/agent.ts),
  [permission evaluation and tool mapping](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/permission/index.ts),
  [global configuration](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/config/config.ts).
- [Antigravity 1.3.0 official archive](https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip):
  the `.par` contains `acp_server/tool_filter.py`, `acp_server/server.py`
  (`_create_agent_config`) and `google/antigravity/types.py` (`BuiltinTools`).
