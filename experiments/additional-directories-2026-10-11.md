# Additional workspace directories, 2026-10-11

OAR now exposes `SessionOptions.additionalDirectories`. A host can supply
extra workspace paths without constructing runtime-specific arguments.
The contract and adapter opening code own this mapping; no new records or
view state are required. Paths resolve relative to cwd, duplicates are
removed and cwd remains primary. Omitted or empty sends no override.
Loading project rules or instruction files varies by runtime and is not
guaranteed by this option.

## Native evidence

Linux x64. Claude, Codex and Kimi use real runtimes with a local scripted
provider in temporary configuration homes. OpenCode and Antigravity's
handshakes need no model call. No real account was used for those probes.

| Runtime | Native channel and observation | OAR mapping |
|---|---|---|
| Claude 2.1.296 | `--add-dir`; the provider request's user environment context names the extra directory. New and resumed processes both verified. | Same flag, including resume. |
| Codex 0.162.1 | Generated app-server schema exposes `runtimeWorkspaceRoots` on thread start/resume and their replies. New/cold-resumed roots are reported exactly as supplied. | Send cwd plus extras, check the native readback, fail an ignored/unreported override. |
| Cursor SDK 1.0.37 | `LocalAgentOptions.dirs`; a model reports cwd plus the first extra root on create, then cwd plus the second on resume. | SDK `local.dirs` on both opens. |
| Kimi 2.1.1 | Initialize advertises `sessionCapabilities.additionalDirectories`; `session/new` puts the path in the provider request. Resume ignores a different extra directory, including after process restart. | New only; resume with a non-empty list rejects before launch. |
| OpenCode v2 2.0.26 | Initialize advertises the extension; `session/list` reports the supplied list on new and resumed sessions. After restart, resume without the field reports no extra roots. | ACP field on both opens; supply again on resume. |
| OpenCode v1 1.18.35 | No capability advertised or additional-workspace input in its ACP source. `external_directory` is a permission rule, not workspace configuration. | Refuse before prompt preparation or ACP open. |
| Grok 1.0.50 | No capability advertised. Source logs imported Claude additional directories as unsupported and rejects a resume's field. | Declare refusal before launch. |
| Antigravity 1.3.0 | No capability advertised. `new_session` accepts the parameter but builds harness workspaces from cwd and skill directories only. | Declare refusal before launch. |
| Pi / Pi Durable 1.1.0 | SDK session options / agent configuration expose cwd, not a multi-root workspace setting. Pi tools may already accept absolute paths; Durable's host owns the environment. | Declare refusal before creating or changing a session/conversation. |

Codex's native roots are a **replacement** list, including roots otherwise
selected by native configuration. OAR includes cwd and does not rewrite the
sandbox configuration. The native and OAR-level probes both preserved
`workspace-write`, `read-only` and `danger-full-access` across new and cold
resumed sessions. A read-only session stays read-only. A loaded thread in the
same app-server can ignore a root override; OAR's reply check refuses that
result rather than claiming it applied. OAR normally owns a fresh app-server
for every open.

Claude did not load an extra directory's `CLAUDE.md` by default. With native
`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, the marker did reach the
provider request. OAR leaves this separate setting to the host's `env`.

Cursor's `.d.ts` also describes project-rule and skill discovery for every
root. Two initial marker probes did **not** see their rule marker, including
with separate git repositories and `AGENTS.md`. A subsequent create/resume
probe established current workspace metadata only. Rule/skill discovery and
OS access enforcement are not claimed here. The four actual model calls
used the authorized existing xxwork login and `gpt-5.4-nano`: 43,380 reported
tokens in total, including 9,216 cache-read tokens. No account identifiers
are included.

## Reproduce and retain

- [Native Claude/Codex probe](additional-directories-native.ts): isolated
  configuration, local provider, each sandbox mode and cold resume.
- [ACP probe](acp-additional-directories-native.ts): run separately with Kimi
  or OpenCode v2; prints capability, native list and provider-context evidence,
  including cold resume. No real account or paid model.
- [Cursor probe](cursor-additional-directories.ts): **uses a real login and
  quota**. Checks workspace paths; rule markers remain diagnostics.
- [Adapter regressions](../tests/additional-directories.test.ts),
  [ACP wire/capability regressions](../tests/acp/acp-additional-directories.test.ts),
  and [native vendor tests](../sea-trial/vendor/additional-directories.vendor.test.ts).
  The latter run under `OAR_TEST=claude-aimock`, `codex-aimock`, or `kimi-aimock`.

Source evidence: Codex's generated v2 ThreadStart/Resume Params/Response
schemas and [runtime-root configuration](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/config/mod.rs);
Kimi's [ACP server](https://github.com/MoonshotAI/kimi-code/blob/0999454bdcb5ddd98f39bffee434dcf0a810f394/packages/acp-server/src/server.ts)
(new-session `additionalDirs`, ignored resume/load input); installed Cursor
SDK `options.d.ts`, `index.js` and `464.js`; installed Pi SDK `core/sdk.d.ts`
and Pi Durable `harness/types.d.ts`. Grok and Antigravity's current source
observations extend their existing runtime-page audits.

The first Claude probe looked only in the system field, but the directory
is in the user environment text. Codex cannot resume a new thread before its
first turn creates rollout material; a same-process resume also ignored the
replacement. Those initial failures and the corrected cold-process runs are
retained with the local run logs. The final probes assert the actual native
locations and sequence instead of weakening the expected directory effect.

## Host impact

`RefusableSessionOption` gains `additionalDirectories`; exhaustive switches
must handle it. Runtime-wide refusals are declared normally. Kimi's resume
restriction and OpenCode's release-line restriction are conditional and
checked at open. Unsupported ACP capability advertisements reject before
creating/resuming a session. No native permission mode or record shape changes.

## Validation

The final full check passed (1,649 unit tests and the mock behavior suite),
as did the build and all five behavior backends. Five native vendor cases
cover Claude new/resume, all three Codex sandbox modes across new/resume,
and Kimi new-session context plus explicit resume refusal. The native
Claude/Codex and Kimi/OpenCode experiment scripts passed with their final
assertions. Cursor's real-login results above are separate from those
repeatable, account-free checks.

## Windows CI follow-up

The first cross-platform run exposed two test assumptions. Claude's request
kept the original Windows short path, but the assertion searched serialized
JSON with an unescaped path. The corrected comparison escapes both sides.
Codex's root readback likewise kept the exact short-path spelling.

Codex's `workspace-write` case selected `readOnly` already at new-session
open, before resume. Its native
[`effective_sandbox_mode`](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/config/src/config_toml.rs#L820)
fallback selects read-only on Windows when the native Windows sandbox is
disabled. The vendor regression now also opens and cold-resumes a session
without extra directories, then requires both directory-override opens to
keep that same native sandbox selection. This tests the platform baseline
separately from the workspace-root mapping.
