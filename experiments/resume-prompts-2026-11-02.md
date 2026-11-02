# Prompt options on resumed sessions

Runtime version check: 2026-11-02

Local Linux x64, synthetic providers only. Claude 2.1.316 and Codex 0.166.0
were run from explicit executables, rather than older installations on PATH.
Qwen 0.26.5 and bundled Pi 1.4.0 supply the immediate-effect controls.

## Compaction changes the answer

Each Claude/Codex case creates a session with an old marker, closes it, resumes
the same ID with a new value or the option omitted, and observes the main
provider request before and after native compaction. A prior user message
must survive the resume. Selection uses the last user input, never the system
marker being asserted. Compaction/naming/memory side requests are excluded.

| Runtime and option | New value, before / after compaction | Omitted, before / after compaction |
| --- | --- | --- |
| Claude replacement | old / new | old / default |
| Claude append | old / new | old / default |
| Codex replacement | new / new | old / old |
| Codex append | old / new | old / default |

Claude receives `/compact` through the existing prompt channel. Its native
`compact_boundary` confirms completion; there is no start frame. Codex is
configured with `model_auto_compact_token_limit = 100000`; one scripted reply
reports 200,000 input tokens and the following turn performs native automatic
compaction, reporting both start and completion. No OAR manual-compaction API
is introduced. The Codex custom API-key provider exercises local compaction;
remote compaction under a ChatGPT login is not covered.

All eight cases passed. They now live in
[`resume-system-prompt.vendor.test.ts`](../sea-trial/vendor/resume-system-prompt.vendor.test.ts)
and read `Runtime.resumedSessionOptions` for expectations. The nine Qwen/Pi
SDK/RPC cases in
[`resume-fresh-prompts.vendor.test.ts`](../sea-trial/vendor/resume-fresh-prompts.vendor.test.ts)
also read the declaration, as do the two Pi Durable append cases in
[`pi-durable.vendor.test.ts`](../sea-trial/vendor/pi-durable.vendor.test.ts).
Every case now checks supplied and omitted values both before and after
native compaction. Qwen/Pi omission restores defaults; Pi Durable omission
retains saved instructions after compaction too. The Qwen/Pi sequence creates
an old value, resumes with a new value, then resumes with omission. Expected
saved values are tracked from the preceding session, rather than always using
the original marker.

Qwen runs native `/compress` through its existing stream-json prompt channel.
The native assistant frame must report `Context compressed (... -> ...)` with
a smaller resulting token count; command acceptance alone is insufficient.
Pi SDK/RPC use a 100,000-token context window with 20,000 reserved tokens;
Durable uses its 200,000-token model window with 120,000 reserved tokens and
background compaction disabled. A selected normal response reports 90,000
input tokens. Pi then compacts automatically; Qwen receives `/compress`.
Only recognized native summary requests receive a unique summary marker.
The later main provider request must contain that marker in its history;
ordinary replies never contain it. This proves native compaction completed,
including runtimes without normalized compaction events. Qwen's summary usage
also reports the history tokens it consumed, so its native benefit check does
not reject a nominal summary that claims to have compressed no input.

All 19 controls passed locally; cross-platform results belong to the PR's
native CI jobs. The [declaration inventory test](../tests/resumed-session-options.test.ts)
fixes the measured runtimes and option keys, including both Pi execution modes
and Pi Durable, and rejects overlap with `refusedSessionOptions`. Adding a
new declaration requires updating this inventory and its native regression.

Deliberately incorrect declarations fail the controls: the eight additional
runtime/dimension runs cover Qwen, Pi SDK, Pi RPC and Pi Durable, changing
supplied timing or omission behavior. In particular, changing Durable's
`omitted: "saved"` to `saved_until_compaction` now fails specifically after
compaction. Changing Qwen/Pi omission to `saved` expects the **new** marker
from the preceding resume and fails against the actual default, confirming
the expectation no longer incorrectly uses the seed value.

Run the Claude/Codex file with `OAR_TEST=claude-aimock` or `codex-aimock` and
`pnpm vitest run sea-trial/vendor/resume-system-prompt.vendor.test.ts`.
Use `OAR_CLAUDE_BIN` / `OAR_CODEX_BIN` to choose an explicit installed binary.
Failed cases retain raw requests and records under `oar-trial-run/resume-prompts`.

## Grok control

Grok 1.0.70 (`f50904eaee6c`, stable) behaves differently. An experiment bypasses
only OAR's append-only resume refusal, creates an append-only session, then
resumes with a changed append and calls the native ACP extension
`_x.ai/compact_conversation` (the wire form of the
[native extension dispatch](https://github.com/xai-org/grok-build/blob/bc7f02e/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L2560-L2562)).
The successful reply is `{}`. A unique summary marker appears in the next
main request's history, confirming that this is a completed compaction control.
That request still uses the **old** append, with no new marker.

[Selected observations](grok-resume-compaction-2026-11-02.json) preserve the
version, platform, native response, provider-request count during compaction,
and before/after markers. Reproduce with
`pnpm tsx experiments/grok-resume-compaction.ts [output-directory]`:
[`probe`](grok-resume-compaction.ts) writes raw requests and OAR records next
to `selected.json`. No product Grok behavior changes; its refusal is retained.
The error now explains the migration rule below.

## Host migration and release note

Claude accepts both prompt options on resume; Codex accepts append on resume.
Previously these opens were refused. A different Claude prompt or Codex
append takes effect after the next native compaction. **Pass the current
prompts on every resume** so they remain effective after compaction. Codex's
replacement prompt applies immediately and survives omission.

**Grok append-only is the exception:** omit `appendSystemPrompt` on resume to
retain its saved value, including after compaction. Sending even unchanged
append text is refused because OAR cannot compare it with the saved value.
To change it, supply `systemPrompt` as well. OAR does not inject a replacement
or silently discard an option.

The optional `Runtime.resumedSessionOptions` map reports supplied-value timing
and omitted-value behavior independently; absent entries mean untested. It
neither duplicates refusal declarations nor adds an OAR fallback or compaction
control. Conditional Grok/OpenCode support and unmeasured Qoder/CodeBuddy
omission remain undeclared. See the
[contract and complete table](../docs/spec/runtime-matrix.md#resumed-session-options).
