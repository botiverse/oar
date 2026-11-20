# Codex thread instructions across compaction and collaboration modes

On Codex 0.170.0 and 0.171.0, the local Responses provider received the host's
`appendSystemPrompt` exactly once as a developer message in the initial request
and in both ordinary requests after compaction. Switching collaboration modes
also preserved it. The table below distinguishes the thread instruction from two other ways to
send developer text. [Codex runtime page](../../docs/runtimes/codex.md#models-instructions-and-context)

## Measurements

Linux x64, 2026-11-20. **[env]** Each row ran the real Codex app-server with a
new isolated home, OAR's thread-open parameters and aimock. Markers were unique
to the indicated field. The observations below come from the native JSON
bodies received at `/v1/responses`. Aimock returned fixed replies containing
none of the markers. The remote-v2 fixture returned a synthetic compaction
item over the native Responses protocol. No authenticated provider was used.
[Probe](probe.ts), [0.170.0 requests](0.170.0.json), [0.171.0 requests](0.171.0.json)

| Condition | Thread developer instruction | Independent control on the same requests |
| --- | --- | --- |
| Manual compaction, local and remote-v2 | Present on both following turns | An ordinary developer message added with `thread/inject_items` disappeared. A one-time application `additionalContext` value disappeared on 0.170.0 and remained on 0.171.0. |
| Automatic compaction, local and remote-v2 | Present on both following turns | Both the injected message and the one-time application context disappeared on both versions. |
| Switch from Plan to Default, with catalog text for Default | Present on the switch and following turn | The catalog's Default text reached the model input. The marker in `collaborationMode.settings.developer_instructions` was absent. |
| Switch from Default to Plan, without catalog text for Plan | Present on the switch and following turn | The marker in `collaborationMode.settings.developer_instructions` appeared as developer text and remained on the following turn. |

Each compaction run captured four requests: seed, compact, first follow-up,
second follow-up. The native `contextCompaction` item started and completed
with the same ID. The remote-v2 runs also observed a `compaction_trigger` on
request two and the returned compaction item on requests three and four.
The manual cases called `thread/compact/start`. For the automatic cases the
seed reply reported 110,004 tokens against a 100,000-token threshold.
The two collaboration controls used the bundled `gpt-6.2-sol` catalog entry
and sent different markers at thread open and mode selection.

## Cold resume and fork

**[env] Codex 0.171.0.** Six additional runs used the public OAR session API.
Each seeded and disposed a session, then opened a new app-server process
with the same home. Resume returned the source thread ID. Fork returned a new
ID. All six issued a successful manual compaction after the first reopened
turn. These were the developer markers on the ordinary provider requests.
[Public API probe](reopen.ts), [selected requests](reopen-0.171.0.json).

| Append supplied on reopen | Before compaction, resume and fork | After compaction, resume and fork |
| --- | --- | --- |
| Same as the original | Original | Original |
| Different | Original | New value only |
| Omitted | Original | Neither marker |

The existing vendor regression also passed both Codex append cases on
0.171.0 with automatic local compaction after cold resume. The native code
distinguishes stored history from the field used to build the next context.
A direct resume of an already loaded thread ignores a developer-instruction
override. OAR's isolated opener starts a process for each session. [Vendor regression](../../sea-trial/vendor/resume-system-prompt.vendor.test.ts),
[Codex session metadata](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/protocol/src/protocol.rs#L3520),
[Codex turn context record](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/protocol/src/protocol.rs#L3699),
[loaded-thread override handling](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/app-server/src/request_processors/thread_processor.rs#L273-L282),
[OAR session opener](../../packages/oar/src/runtimes/codex/session.ts).

## Native source

OAR sends the appended instructions in the thread-open field
`developerInstructions`. Codex carries that value from session configuration
to the turn context and renders it as a developer fragment when assembling
initial context. Both the local summarizer and remote-v2 installation rebuild
this context when replacing history. [OAR mapping](../../packages/oar/src/runtimes/codex/open.ts),
[native turn context](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/core/src/session/turn_context.rs#L1187),
[developer fragment](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/core/src/session/mod.rs#L5168-L5178),
[local replacement](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/core/src/compact.rs#L443-L457),
[remote-v2 replacement](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/core/src/compact_remote_v2_installation.rs#L225-L265).

T3 Code's compaction workaround explicitly reinjects client messages. Codex
applies separate retention rules to injected history. Its collaboration-mode
resolver prefers the catalog override, then reads the nested mode instruction.
The thread-open instruction is supplied independently. [T3 compaction comment and reinjection](https://github.com/pingdotgg/t3code/blob/4d5bf2d5579f10a521e0ab4899fcef96de5e4b41/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L1987-L2011),
[T3 mode comment](https://github.com/pingdotgg/t3code/blob/4d5bf2d5579f10a521e0ab4899fcef96de5e4b41/apps/server/src/provider/CodexDeveloperInstructions.ts#L40-L44),
[Codex client-message retention](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/core/src/compact_remote_v2.rs#L618-L633),
[Codex mode resolution](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/core/src/context/world_state/collaboration_mode.rs#L28-L47).

## Reproduce

From the repository root with dependencies installed, point the probe at
either tested Codex binary. It prints the native version, matched compaction
notifications and selected request fields. Each array records the roles of
messages containing that marker, in request order. To keep complete request
bodies locally, set `OAR_PROBE_RAW_DIR` to an existing private directory.

```sh
OAR_CODEX_BIN=/absolute/path/to/codex pnpm tsx experiments/codex-instruction-retention/probe.ts
OAR_CODEX_BIN=/absolute/path/to/codex pnpm tsx experiments/codex-instruction-retention/reopen.ts
```
