# Antigravity first-prompt MCP readiness

Observed November 13, 2026. The macOS name-clash vendor case intermittently
loses the native MCP catalog on **agy 1.5.0**, not on a newly installed 1.5.7.
Its session MCP process answered `initialize` and `tools/list` before the
prompt, but the first agent request offered no MCP tools. The reason the
preloaded tools were omitted is still unknown.

The natural failures investigated so far use a session server replacing a
same-name user server. This does **not** establish that the problem requires
a name clash. Linux controls with and without a clash passed. No supported
native readiness signal has been verified, so this change documents the
limitation and preserves the original test, deadlines and product behavior.

## Failed run and passing controls

The failure is in [main run 43346560094, macOS check job
131627220977](https://github.com/botiverse/oar/actions/runs/43346560094/job/131627220977),
attempt 1, at `63897d09685772a43d8225b92097af1b11a47b53`.
The installer printed `Verified agy CLI 1.5.0`; the retained native worker
also reported 1.5.0. The host was macOS arm64 with Node 24.22.2.
The name-clash case returned zero echo results instead of two. The other
MCP case, which attaches stdio and HTTP servers without user entries and
resumes the session, passed in that job.

| Run and host | First agent request | Echo results | Selected evidence |
| --- | --- | --- | --- |
| Main 43346560094, macOS | 12 built-in tools, no MCP tools | Neither result | [failure](main-macos.json) |
| Main 43346560094, Linux | 16 tools, including four MCP entries | Both results | [Linux control](main-linux.json) |
| Main 43346560094, Windows | 16 tools, including four MCP entries | Both results | [Windows control](main-windows.json) |
| PR 761 run 43344246157, macOS | 16 tools, including four MCP entries | Both results | [earlier macOS control](pr761-macos.json) |

The four MCP entries are `mcp_echo_echo`, `call_mcp_tool`, `list_resources`
and `read_resource`. Request 1 is a separate title request without tools;
the comparison above is request 2, the first main agent request. Tools
mentioned in a prompt or result are not counted as declarations.

The [passing PR 761 macOS job](https://github.com/botiverse/oar/actions/runs/43344246157/job/131619609986)
also verified agy 1.5.0. Its head
`d9d6f5729432d532d46ebe58efff1d2f605269d2` and the failed main head have the
same Git tree, `889a7262ebd17c3e0ade179faff62a0c5403c50b`.
Thus the observed difference is not a code or pinned-version change.
Earlier November 11 investigation found the same missing-catalog symptom
in the name-clash case; [PR 737](https://github.com/botiverse/oar/pull/737)
added the failure capture that makes this timeline possible. The detailed
timeline here belongs only to the November 13 sample.

## Failed-session timeline

All times below are UTC, 2026-11-13 **01:49:47**, on the same runner.
The native front session id and the unique name-clash prompt were used to
correlate the worker log, OAR records and provider capture. Identifiers and
machine paths are excluded from the selected results.

| Milliseconds within the second | Observation |
| --- | --- |
| 176.307 | Worker reports version 1.5.0. |
| 328.565 | Worker logs preloading one session MCP server. |
| 401, 404, 405 | Session `echo` starts, replies to initialize, then replies to tools/list. |
| 406 | Session echo observes stdin close and exits successfully. |
| 419, 420 | OAR records the prompt and its accepted response. |
| 420.779 | Worker receives session/prompt. |
| 478 | First main model request has 12 built-in declarations and no MCP entries. |
| 506 | Next model request contains the native unknown-tool error for mcp_echo_echo. |
| 522 | Next request also contains the unknown-tool error for call_mcp_tool. |
| 534, 535 | OAR records a completed turn, then disposal. |
| 561, 570 | User echo and userecho processes start. |
| 574, 583 | Those two processes finish initialize/tools/list handshakes. |
| 614 | Disposal records process exit. |
| 627 | Failure evidence manifest is written. |

All three MCP processes started and replied to discovery. None received
`tools/call`. This is not evidence that the servers never started. User
MCP startup happened after the completed turn; the session server had
already been preloaded and closed. The logs do not explain why its tools
were omitted from the model request or prove which internal race caused it.
The final model text was scripted by the local fixture; it does not prove
tool execution or successful MCP setup.

The failure manifest records all five files without truncation or read
errors and zero omitted native files. Complete raw artifacts and job logs
were retained before any follow-up. The macOS artifact is
`agy-acp-macos-latest`, id `14002616826`; archive SHA-256:
`e8e01908a733565f1830a01c8e3ff09391bf90512e99d468e5ff8367c3d0d1e9`.
Selected JSON also carries hashes of its source provider and trace files.
No CI rerun was used to replace this failed sample.

## Configuration and readiness controls

[probe.ts](probe.ts) drives the actual CLI through ACP with a fresh HOME,
a local scripted Gemini provider and credential-free echo servers. Its
three configurations are:

- `session-only`: session echo, no user server.
- `other-user`: session echo plus the user's differently named userecho.
- `same-name`: user echo and userecho, with session echo replacing user echo.

Each runs with zero or 1,000 ms added MCP startup delay on Linux x64, on
both 1.5.0 and 1.5.7: **12 configuration/version controls**. All passed on
the initial probe. After extracting typed summary helpers, all 12 passed
again, for 24 local sessions in total. Each session has two prompts, all
served locally. [linux-controls.json](linux-controls.json) keeps both
rounds separately; none is a retry of the failed macOS CI sample.

The first prompt is sent immediately after session/new. It calls the
session echo and, where configured, the user's userecho. The second prompt
observes the subsequent catalog. The delay before that second prompt is an
observation window **after the first turn completes**, not a proposed
open-session wait. Both first and second catalogs included the MCP entries;
every required first-turn echo result reached the provider. No unknown-tool
error occurred.

Added MCP startup delays increased session/new time. For example, the
initial 1.5.0 same-name control took 409 ms without the extra delay and
2,422 ms with it; session tools/list finished at 378 and 2,391 ms,
respectively, measured from the open request. Slowing these servers alone
did not reproduce the failure.

The direct probe advertises empty ACP clientCapabilities, while OAR's
session client advertises its filesystem/terminal capabilities. It uses
the same per-session worker arguments, but does not reproduce every OAR
opening step or the macOS runner's scheduling. The wrapper also adds Node
module loading to the fixture startup. These are bounded controls, not an
exact replay or proof that non-clashing configurations or 1.5.7 are safe.
No new macOS 1.5.7 run was performed.

Observed session/new reply keys were `sessionId`, `models`, `modes` and
`configOptions`, without a tool catalog. Notifications were session updates
for available commands, user text, agent text and tool calls. No MCP-ready
notification was observed. The [official ACP reference](https://antigravity.google/docs/ide/extensions/acp/)
was also checked; no MCP-ready notification or catalog-bearing open reply
was documented there. This does not rule out undocumented extensions or
internal readiness machinery. Neither an available-commands update nor
completion of one server's discovery has been verified as a usable barrier.

## Reproduce and retain evidence

Use Node 24+, pnpm and Python 3. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm tsx experiments/antigravity-mcp-readiness/probe.ts \
  /absolute/path/to/antigravity /new/private/output-directory
```

The output directory must not exist. The probe runs six ordered cases with
the supplied binary, prints one JSON result per case, writes selected
results plus private ACP/provider/native logs, and exits nonzero if a case
fails. It does not sign in, change an existing login or contact a paid model.
Do not publish its private files: native output can contain local paths.
The checked Linux binary SHA-256 values were:

| Version | SHA-256 |
| --- | --- |
| 1.5.0 | b9043860a06a3bfa70b68f06c3d4527abc16207767f14ae9d1e06e3026081862 |
| 1.5.7 | 5df525a2d6908989c57b897723caea66e00d7c4d2e24411f91ad306989574642 |

To exercise the unchanged OAR vendor case with a supplied CLI:

```sh
OAR_ANTIGRAVITY_BIN=/absolute/path/to/antigravity \
OAR_TRIAL_RUN_DIR=/new/private/vendor-output \
OAR_TEST=antigravity-aimock OAR_TEST_REQUIRE_AVAILABLE=1 \
  pnpm exec vitest run sea-trial/vendor/mcp-servers-acp.vendor.test.ts \
    -t 'a server named like'
```

This is an intermittent failure, so a pass does not invalidate the retained
sample. On failure keep the complete job log, provider and OAR traces, and
`agy-mcp-failure/<id>/` before removing the isolated home.
[select-ci.py](select-ci.py) regenerates the four CI selections from their
downloaded artifacts:

```sh
python3 experiments/antigravity-mcp-readiness/select-ci.py \
  /path/to/extracted/agy-acp-macos-latest > /private/selected.json
```

The selector expects exactly one synthetic name-clash session and extracts
only catalog names, echo markers without credential fingerprints and event
times. It is not a general sanitizer for arbitrary real-account logs.
The [upstream issue draft](upstream-issue.md) asks for the native readiness
contract and the cause of the missing preloaded tools; it makes no claim
that an upstream fix or supported wait exists.
