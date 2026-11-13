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
OAR's refusal is an `UnsupportedOptionError` with `option: "cwd"`
([refused session options](../spec/runtime-matrix.md#refused-session-options)).

The kimi, opencode, antigravity and devin adapters require a positive native
`session/list` entry with a non-empty saved cwd before sending resume/load,
even when the requested cwd appears unchanged
([resume-cwd.ts](../../packages/oar/src/shared/acp/resume-cwd.ts)). Missing
listing support, an incomplete list or an unlisted id also refuses with
`option: "cwd"`; a native listing failure prevents resume and retains its
error. Absence from a list is not absence of history: agy 1.5.0 omits
unprompted sessions that native resume can still reopen. Hosts may start a
new session, but must not infer `SessionNotFoundError` from this refusal.
DSH compares the cwd in its saved session header instead, and a header
without one refuses with `option: "resume"` ([DSH](dsh.md#oar-mapping)).
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
