# Resume in another working directory

A host that moves a conversation to another directory either resumes the same
native conversation there, when the runtime can, or starts a new one with a
handoff. Which runtime can is measured, not read off a resume method that
takes a `cwd`.

[`experiments/resume-other-cwd.ts`](../../experiments/resume-other-cwd.ts),
run 2026-10-03 on linux x64: open in directory A, teach a codeword, dispose;
resume the same id with `cwd` B; ask the model to run `pwd && ls` and to say
the codeword. Supported means the resume opens, the codeword comes back, and
the shell runs in B.

| Runtime | Version, model | Resume naming B |
|---|---|---|
| claude | 2.1.288, haiku | Supported: the codeword, and `pwd` in B |
| codex | 0.160.0, its default | Supported: the codeword, `pwd` in B, `ls` listing B |
| cursor | `@cursor/sdk` 1.0.35 | Refused at open: the SDK finds an agent only under the directory it was created in (`AgentNotFoundError`) |
| pi | SDK 1.0.0 | Refused at open: pi keeps sessions per directory (no session file under B) |
| grok | 1.0.46 | Refused at open: grok answers the resume with `Path not found.` |
| kimi | 2.1.1 | Natively kept in A without a word (its shell ran `cd <A> && pwd`); OAR refuses at open after reading the session's directory from `session/list` |
| antigravity | agy CLI 1.5.0, local Gemini provider (2026-11-05) | Native resume keeps the original cwd; OAR reads `session/list` and refuses a different cwd before prompting ([control](../../experiments/antigravity-cli-acp-2026-11-05.md)) |
| opencode | 1.18.30, opencode/big-pickle (2026-10-05) | Natively kept in A without a word (`pwd` printed A, the transcript intact); OAR refuses at open after reading the session's directory from `session/list`, for a git repository in B too |

Current OAR maps the verified missing-target signals to
`SessionNotFoundError` ([mapping and scope](../spec/runtime-matrix.md#missing-resume-targets)).
For Pi and Grok this means absent for the supplied cwd; for Cursor it means
not found by the SDK with the supplied configuration. Persist and reuse the
original cwd before deciding the old conversation is gone. The table above
records the historical native errors, not a global absence guarantee.

A refusal is the runtime's error from `session()` (OAR's own for kimi,
opencode, antigravity, devin and dsh), so a host that tries a resume in B and falls
back to a handoff on refusal never runs in a directory it did not ask for.
For ACP directory guards and DSH's different-directory refusal, OAR throws the
public `ResumeCwdError`, a subclass of `UnsupportedOptionError` with
`option: "cwd"`. Existing `instanceof UnsupportedOptionError` checks still
work and the messages are unchanged
([refused session options](../spec/runtime-matrix.md#conditional-refusals)).

The error carries `sessionId`, `requestedCwd`, and `reason`. `savedCwd` is
present only for `other_cwd`, containing the directory the runtime reported.
The root and portable entries export the same class and the
`ResumeCwdReason` type.

| Reason | Observation |
|---|---|
| `not_listed` | A valid, completed native listing did not contain the requested id. |
| `other_cwd` | The saved cwd was read, but does not match the requested directory. |
| `cwd_unreported` | The id was listed without a non-empty string cwd. |
| `listing_unavailable` | No `session/list` capability, a malformed page, or an invalid or repeating pagination cursor prevented confirmation. |

Kimi, OpenCode v1/v2 (including background-child sessions), Antigravity and
Devin require a positive native `session/list` entry with a non-empty saved
cwd before sending resume/load, even when the requested cwd appears unchanged
([resume-cwd.ts](../../packages/oar/src/shared/acp/resume-cwd.ts)). Native
listing errors, including authentication, RPC, deadline and process failures,
keep their own error types and prevent resume; they are not converted to
`listing_unavailable`.

`not_listed` is not proof that history is gone: agy 1.5.0 omits sessions
closed before their first prompt, even though native resume can reopen them.
A host can distinguish an unlisted id from a check that could not finish,
but must not translate either into `SessionNotFoundError`. OAR neither starts
a replacement session nor selects a host fallback.

DSH compares its saved session header instead of a list. A different cwd
produces `ResumeCwdError` with `reason: "other_cwd"`; a header without a
string cwd still refuses the `resume` option with `UnsupportedOptionError`,
not a `cwd` refusal ([DSH](dsh.md#oar-mapping)). Native missing-session and
header-read errors also retain their existing classifications.

Factory (droid 1.12.1) reads the saved directory from the `load_session`
answer: a different one produces `ResumeCwdError` with `reason: "other_cwd"`
([Factory](factory.md)). An unknown id is `SessionNotFoundError` (`-32004`).
Devin (`devin 3000.12.57`, 2026-11-13) records the session's `cwd` in
`session/list` and enables `resumeKeepsSessionCwd: true`, so OAR applies the
same `session/list` guard before `session/load`; cross-directory shell execution
was not run without an authenticated model turn.
Not measured here: qwen, qoder, codebuddy, dsh, pi-durable, and runtimes whose session
store the host moved by hand.

The directory comparison shared by these ACP adapters and DSH
([same-directory.ts](../../packages/oar/src/shared/same-directory.ts))
compares existing paths through the native filesystem lookup. Links, Windows
8.3 short names and casing differences that refer to the same directory are
accepted, as is agy 1.5.0's Windows `/D:/path` form; another directory is
still refused. If lookup fails, comparison
falls back to resolved path strings, without assuming that different names
or casing refer to the same missing or inaccessible directory.
The [directory regressions](../../tests/acp/same-directory.test.ts) use real
filesystem aliases; the Windows short-name case explicitly skips if the
temporary directory has no distinct 8.3 name.
