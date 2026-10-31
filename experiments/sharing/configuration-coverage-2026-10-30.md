# Configuration coverage and complete probe failures

Runtime version check: 2026-10-30.

This follow-up changes experiments only. It preserves simultaneous failures,
adds native configuration observations, and records the earlier
[three-platform same-directory run](same-directory-2026-10-30.md#three-platform-confirmation).
It enables no runtime sharing and makes no admission decision.

## Failure and cleanup semantics

An observation error, independent evidence-reader errors and a subsequent
cleanup error are now retained together. Every registered evidence reader
runs, and every acquired resource still reaches cleanup. The JSON error
text expands nested aggregate errors instead of printing only their summary.
This covers partial setup, a synchronous observer throw, a failed hook
journal, a failed MCP journal, and a failed native stop.

`failureReasons` lists all observed boundary failures. For example, Qoder's
missing instruction input and actual shared MCP crossover appear together;
one no longer hides the other. OpenCode additionally reports the old MCP
server's invocation after release. Missing evidence continues to produce a
nonzero exit. No retry, assertion relaxation or product change is involved.

## Added native configuration coverage

The revised local observations use the same exact runtime versions on a
local Linux x64 host, with disposable configuration and scripted local model
responses. [Selected evidence](selected-configuration-coverage-2026-10-30.json)
retains the current probe's observations separately from the earlier platform
run. Project markers never occur in user prompts. ACP evidence now also
retains raw provider requests, selecting the current synthetic user turn
rather than an older prompt in history.

| Runtime | Instruction source tested | Hook source | Later B compared with a fresh process |
| --- | --- | --- | --- |
| Codex 0.166.0 | `AGENTS.md` | disposable `CODEX_HOME/hooks.json`, `PreToolUse` | marker B and hook B on both paths, with the per-session trust condition below |
| Grok 1.0.70 | `AGENTS.md` | disposable `GROK_HOME/hooks/directory.json`, `PreToolUse` | marker B and hook B on both paths, with folder trust disabled before startup |
| OpenCode 2.2.3 | `AGENTS.md` | local V2 plugin, `ctx.tool.hook("execute.before", ...)` | instruction markers and hook revisions agree; MCP crossover and retention still fail |
| Antigravity 1.4.5 | `GEMINI.md`; earlier separate `AGENTS.md` attempt | project `.agents/hooks.json`, `PreToolUse` | hooks agree; neither instruction-file attempt exposed a marker, so instruction freshness is missing |
| Qoder 1.1.81 | `AGENTS.md`, but native fake replies expose no model input | project `.qoder/settings.json`, `PreToolUse` | hooks agree; instruction freshness is missing and MCP crossover still fails |
| Kimi 2.4.1 | `AGENTS.md` | disposable `KIMI_CODE_HOME/config.toml`, `PreToolUse` | old shared hook versus new isolated hook; delayed controls retain the discrepancy |

OpenCode's successful MCP turns record both the outer execute hook and the
inner tool-call hook. Both paths therefore retain two hook entries for each
of the five compared inputs; the comparison keeps both entries. The actual
MCP journal still verifies one tool invocation per input. An empty-MCP
reopen without the tool can record only the outer hook.

These are observations of specific files and exercised tools, not claims
that every configuration field is fresh. A missing instruction marker does
not prove that native rules are unsupported. Antigravity's documented rule
locations describe supported product surfaces, but this ACP observation has
not established an effective instruction-file path. Qoder's fake-response
fixture bypasses the model request; output frames cannot establish which
instruction input a real provider would receive. Those two gaps remain
explicit failures. No account login or live model request was used to fill
them.

Native entry-point sources:

- Codex's distributed hook configuration and the app-server request override
  are inspected in its [hook engine](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/engine/mod_tests.rs)
  and [configuration manager](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/app-server/src/config_manager.rs).
  Those source paths guide the experiment; the measured executable is 0.166.0.
- [Grok hooks](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md)
  describe the global hook directory and the folder-trust gate for project
  instructions. The experiment changes only its disposable home.
- [OpenCode V2 server plugins](https://dev.opencode.ai/v2/docs/build/plugins/server/)
  expose `execute.before`. The probe writes a local plain-object plugin,
  without downloading a plugin package, and records its native input.
- [Antigravity hooks](https://antigravity.google/docs/hooks) document named
  hook groups in `.agents/hooks.json`, with `toolCall.args` on stdin.
  [Rules](https://antigravity.google/docs/rules/) document standalone
  instruction files. Their existence is separate from this missing marker.

## Trust is part of the tested configuration

The main Codex comparison supplies `bypass_hook_trust: true` in each native
`thread/start` request before that session opens. This is an explicit
per-session invocation override, not a persisted trust-store approval.
In the control where A explicitly receives `bypass_hook_trust: false`, A has
no hook records. The main Grok
comparison sets `folder_trust.enabled=false` in its disposable user config
before either native process starts. It does not create a persisted folder
grant or modify the real user's configuration. These conditions apply
symmetrically to shared and separate cohorts.

The additional Codex controls exercise both directions: A untrusted then B
trusted, and A trusted then B untrusted. Each direction has a shared and a
separate-process cohort. Both open A and run its MCP turn, edit the hook,
open and invoke B, then invoke A again after B's turn. Every turn must invoke
its own MCP exactly once and retain that native output. Each trusted turn
must have hook records, and each untrusted turn must have none, including
A after B opens. This checks for inherited trust in a later untrusted B and
for either direction of trust change leaking back to A.

The comparison retains all three turns, their hook revisions, each explicit
trust parameter, and B's instruction markers. Expected absence counts only
after the native tool call, retained output and positive trusted-peer hook
were verified. A missing journal or unexecuted tool remains missing
evidence; two empty observations do not pass by themselves.

The four Linux controls completed on 2026-10-31 and passed. With A untrusted
and B trusted, A had no hook records before or after B, while B ran hook B.
With A trusted and B untrusted, A ran hook A on both turns and B had no hook
records. Shared and separate processes matched; each of the three turns
retained its own MCP result. This is evidence for the exercised per-session
parameters, not a persisted trust-store change.

This control tests a changed **per-session parameter**. It does not test a
persisted Codex hook-trust grant made after process startup. Nor does the
Grok run test a persisted folder grant or a change to its trust policy after
startup. Those remain separate configuration-freshness gaps. Existing
results must not be extrapolated to them. The new hook coverage has only
been run locally on Linux; Windows and macOS still need the revised probe.
No runtime version is admitted by this follow-up.

## Reproduction

Run `same-directory.ts` exactly as described in the
[same-directory report](same-directory-2026-10-30.md#reproduction-and-remaining-work).
Codex now also runs four per-session hook-trust controls. Kimi still runs
its six delayed configuration controls. Every native process, mock provider,
hook file and temporary home is owned by the fixture. Both controls retain
all failures before exiting. The ordinary PR gate checks helper regressions;
the manual workflow supplies the platform evidence after review.

The retained selector can rebuild a report from saved observations:
`python3 experiments/sharing/select-directory-evidence.py manifest.json selected.json`.
The manifest is an array with `evidencePath` relative to the manifest,
`requestedVersion`, and a `source` object containing the run, commit and
artifact identifiers (or the local probe base). Optional `exitCode` retains
the complete failure list. Selection omits raw requests, session IDs and
hook payloads; review the supplied source metadata and failure text before
publishing.
Partial reports retain a null reported version when installation is missing;
a missing hook event is retained with `eventMissing: true`. The selector's
partial-evidence regressions run with
`python3 -B -m unittest discover -s experiments/sharing -p test_directory_selection.py`.
